import type {
  IrExpr,
  IrFunction,
  IrGlobal,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import {
  mangleField,
  mangleFnClosure,
  mangleFunction,
  mangleGlobal,
  mangleLocal,
  mangleRawParam,
  mangleRecordStruct,
} from "../mangle.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;

interface RustClosureShape {
  readonly index: number;
  readonly type: IrFuncType;
  readonly targets: IrFunction[];
}

/** A valid IR construct that the incremental Rust backend has not ported yet. */
export class RustUnsupportedError extends Error {
  constructor(
    readonly kind: string,
    readonly loc?: SrcLoc,
  ) {
    super(`rust backend does not support ${kind} yet`);
    this.name = "RustUnsupportedError";
  }
}

/** Emit deterministic, safe Rust. Unsupported IR always refuses explicitly. */
export function emitRustModule(mod: IrModule): string {
  return new RustEmitter(mod).emit();
}

class RustEmitter {
  private readonly lines: string[] = [];
  private readonly functions = new Map<string, IrFunction>();
  private readonly globals = new Map<string, IrGlobal>();
  private readonly records = new Map<string, IrRecordShape>();
  private readonly unions = new Map<string, IrUnionDef>();
  private readonly closureShapes = new Map<string, RustClosureShape>();
  private readonly closureTargets = new Map<string, RustClosureShape>();
  private readonly internedClosureTargets = new Set<string>();
  private indent = 0;
  private temporary = 0;
  private currentFunction: IrFunction | null = null;
  private capturedReturnDepth = 0;
  private readonly loopTargets: { id: number; breakLabel: string; continueBlock: string | null }[] = [];
  private readonly completionLoopBoundaries: number[] = [];
  private nextLoopTargetId = 0;

  constructor(private readonly mod: IrModule) {
    for (const fn of mod.functions) this.functions.set(fn.name, fn);
    for (const global of mod.globals ?? []) this.globals.set(global.id, global);
    for (const record of mod.records ?? []) this.records.set(record.id, record);
    for (const union of mod.unions ?? []) this.unions.set(union.id, union);
    this.discoverClosures();
  }

  emit(): string {
    this.checkModuleSurface();
    this.line("#![forbid(unsafe_code)]");
    this.line("");
    this.line("use scriptc_runtime as runtime;");
    if (this.globals.size > 0 || this.internedClosureTargets.size > 0) {
      this.line("use std::cell::{Cell, RefCell};");
    }
    this.line("");
    this.emitClosureDefinitions();
    this.emitUnionDefinitions();
    this.emitRecordDefinitions();
    this.emitGlobals();
    for (const fn of this.mod.functions) {
      this.emitFunction(fn);
      this.line("");
    }
    const entry = this.functions.get(this.mod.entry);
    if (entry === undefined) this.unsupported(`missing entry '${this.mod.entry}'`);
    if (entry.params.length !== 0 || entry.returnType.kind !== "void") {
      this.unsupported("entry signature", entry.loc);
    }
    this.line("fn main() {");
    this.indent += 1;
    this.line(`${mangleFunction(entry.name)}();`);
    for (const global of this.globals.values()) {
      if (this.isHeapRoot(global.type)) {
        this.line(`${mangleGlobal(global.id)}.with(|slot| *slot.borrow_mut() = None);`);
      }
    }
    for (const fnName of this.internedClosureTargets) {
      this.line(`${mangleFnClosure(fnName)}.with(|slot| *slot.borrow_mut() = None);`);
    }
    this.line("runtime::finish();");
    this.indent -= 1;
    this.line("}");
    return `${this.lines.join("\n")}\n`;
  }

  private checkModuleSurface(): void {
    const userClass = (this.mod.classes ?? []).find((cls) => !cls.runtime);
    if (userClass !== undefined) this.unsupported(`class '${userClass.name}'`, userClass.loc);
    if ((this.mod.ffiImports?.length ?? 0) > 0) this.unsupported("native FFI");
    if (this.mod.embedded !== undefined) this.unsupported("embedded dynamic modules");
    if (this.mod.lib !== undefined) this.unsupported("library mode");
  }

  private discoverClosures(): void {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.kind === "closure") {
        const type = node.type as IrType | undefined;
        const fnName = node.fnName;
        if (type?.kind !== "func" || typeof fnName !== "string") {
          this.unsupported("malformed closure IR");
        }
        const target = this.functions.get(fnName);
        if (target === undefined) this.unsupported(`unknown closure target '${fnName}'`);
        const key = typeKey(type);
        let shape = this.closureShapes.get(key);
        if (shape === undefined) {
          shape = { index: this.closureShapes.size, type, targets: [] };
          this.closureShapes.set(key, shape);
        }
        if (!shape.targets.some((candidate) => candidate.name === target.name)) {
          shape.targets.push(target);
        }
        const existing = this.closureTargets.get(target.name);
        if (existing !== undefined && existing !== shape) {
          this.unsupported(`closure target '${target.name}' with multiple signatures`, target.loc);
        }
        this.closureTargets.set(target.name, shape);
        if (target.captures === undefined) this.internedClosureTargets.add(target.name);
      }
      for (const child of Object.values(node)) visit(child);
    };
    for (const fn of this.mod.functions) visit(fn.body);
  }

  private emitClosureDefinitions(): void {
    for (const shape of this.closureShapes.values()) {
      const name = this.closureName(shape);
      this.line(`enum ${name} {`);
      this.indent += 1;
      for (const target of shape.targets) {
        const captures = target.captures ?? [];
        if (captures.length === 0) {
          this.line(`${this.closureVariant(target)},`);
        } else {
          const fields = captures.map((capture, index) =>
            `${this.captureField(index)}: Option<runtime::JsCell<${this.rustType(capture.type, target.loc)}>>`,
          ).join(", ");
          this.line(`${this.closureVariant(target)} { ${fields} },`);
        }
      }
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${name} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      const capturing = shape.targets.filter((target) => (target.captures?.length ?? 0) > 0);
      if (capturing.length === 0) {
        this.line("let _ = tracer;");
      } else {
        this.line("match self {");
        this.indent += 1;
        for (const target of capturing) {
          const fields = (target.captures ?? []).map((_, index) => this.captureField(index));
          this.line(`Self::${this.closureVariant(target)} { ${fields.join(", ")} } => {`);
          this.indent += 1;
          for (const field of fields) {
            this.line(`if let Some(edge) = ${field} { tracer.edge(edge); }`);
          }
          this.indent -= 1;
          this.line("},");
        }
        this.line("_ => {},");
        this.indent -= 1;
        this.line("}");
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ClearEdges for ${name} {`);
      this.indent += 1;
      this.line("fn clear_edges(&mut self) {");
      this.indent += 1;
      if (capturing.length > 0) {
        this.line("match self {");
        this.indent += 1;
        for (const target of capturing) {
          const fields = (target.captures ?? []).map((_, index) => this.captureField(index));
          this.line(`Self::${this.closureVariant(target)} { ${fields.join(", ")} } => {`);
          this.indent += 1;
          for (const field of fields) this.line(`*${field} = None;`);
          this.indent -= 1;
          this.line("},");
        }
        this.line("_ => {},");
        this.indent -= 1;
        this.line("}");
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line("");
    }
  }

  private emitUnionDefinitions(): void {
    for (const union of this.unions.values()) {
      const name = this.unionName(union.id);
      this.line("#[derive(Clone)]");
      this.line(`enum ${name} {`);
      this.indent += 1;
      union.arms.forEach((arm, tag) => {
        this.ensureUnionArm(arm);
        this.line(this.isUnit(arm)
          ? `${this.unionVariant(tag)},`
          : `${this.unionVariant(tag)}(${this.rustType(arm)}),`);
      });
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${name} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      const traced = union.arms
        .map((arm, tag) => ({ arm, tag }))
        .filter(({ arm }) => this.isTracedHandle(arm));
      if (traced.length === 0) {
        this.line("let _ = tracer;");
      } else {
        this.line("match self {");
        this.indent += 1;
        for (const { tag } of traced) {
          this.line(`Self::${this.unionVariant(tag)}(value) => tracer.edge(value),`);
        }
        this.line("_ => {},");
        this.indent -= 1;
        this.line("}");
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::HeapValue for ${name} {`);
      this.indent += 1;
      this.line("fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      this.line("runtime::Trace::trace(self, tracer);");
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ArrayElement for ${name} {`);
      this.indent += 1;
      this.line("fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      this.line("runtime::Trace::trace(self, tracer);");
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.emitUnionEquality(union);
      this.line("");
    }
  }

  private emitUnionEquality(union: IrUnionDef): void {
    const name = this.unionName(union.id);
    this.line(`fn ${this.unionEqName(union.id)}(left: &${name}, right: &${name}, same_value: bool) -> bool {`);
    this.indent += 1;
    this.line("match (left, right) {");
    this.indent += 1;
    union.arms.forEach((arm, tag) => {
      const variant = this.unionVariant(tag);
      if (this.isUnit(arm)) {
        this.line(`(${name}::${variant}, ${name}::${variant}) => true,`);
        return;
      }
      let comparison: string;
      switch (arm.kind) {
        case "f64":
          comparison = "if same_value { runtime::number_same_value(*left, *right) } else { left == right }";
          break;
        case "bool":
          comparison = "left == right";
          break;
        case "string":
          comparison = "left.as_ref() == right.as_ref()";
          break;
        case "array":
        case "record":
        case "func":
          comparison = "left.ptr_eq(right)";
          break;
        default:
          this.unsupported(`union equality arm '${arm.kind}'`);
      }
      this.line(`(${name}::${variant}(left), ${name}::${variant}(right)) => ${comparison},`);
    });
    this.line("_ => false,");
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("}");
  }

  private emitRecordDefinitions(): void {
    for (const shape of this.records.values()) {
      if (shape.indexValue !== undefined) this.unsupported(`indexed record shape '${shape.id}'`);
      const struct = mangleRecordStruct(shape.id);
      this.line(`struct ${struct} {`);
      this.indent += 1;
      for (const field of shape.fields) {
        const fieldType = this.isEdgeValue(field.type)
          ? `Option<${this.rustType(field.type)}>`
          : this.rustType(field.type);
        this.line(`${mangleField(field.name)}: ${fieldType},`);
      }
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${struct} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      for (const field of shape.fields) {
        if (this.isEdgeValue(field.type)) {
          const name = mangleField(field.name);
          this.line(this.isTracedHandle(field.type)
            ? `if let Some(edge) = &self.${name} { tracer.edge(edge); }`
            : `if let Some(edge) = &self.${name} { runtime::Trace::trace(edge, tracer); }`);
        }
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ClearEdges for ${struct} {`);
      this.indent += 1;
      this.line("fn clear_edges(&mut self) {");
      this.indent += 1;
      for (const field of shape.fields) {
        if (this.isEdgeValue(field.type)) this.line(`self.${mangleField(field.name)} = None;`);
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line("");
    }
  }

  private emitGlobals(): void {
    if (this.globals.size === 0 && this.internedClosureTargets.size === 0) return;
    this.line("std::thread_local! {");
    this.indent += 1;
    for (const global of this.globals.values()) {
      const name = mangleGlobal(global.id);
      switch (global.type.kind) {
        case "f64":
          this.line(`static ${name}: Cell<f64> = const { Cell::new(0.0) };`);
          break;
        case "bool":
          this.line(`static ${name}: Cell<bool> = const { Cell::new(false) };`);
          break;
        case "string":
          this.line(`static ${name}: RefCell<runtime::JsString> = RefCell::new(runtime::empty_string());`);
          break;
        case "array":
        case "record":
        case "union":
        case "func":
          this.line(`static ${name}: RefCell<Option<${this.rustType(global.type)}>> = const { RefCell::new(None) };`);
          break;
        default:
          this.unsupported(`global type '${global.type.kind}'`);
      }
    }
    for (const fnName of this.internedClosureTargets) {
      const shape = this.closureTargets.get(fnName);
      if (shape === undefined) this.unsupported(`missing interned closure shape '${fnName}'`);
      this.line(`static ${mangleFnClosure(fnName)}: RefCell<Option<runtime::Gc<${this.closureName(shape)}>>> = const { RefCell::new(None) };`);
    }
    this.indent -= 1;
    this.line("}");
    this.line("");
  }

  private emitFunction(fn: IrFunction): void {
    if (fn.async) this.unsupported(`async function '${fn.name}'`, fn.loc);
    if (fn.generator !== undefined) this.unsupported(`generator function '${fn.name}'`, fn.loc);
    for (const local of fn.locals) {
      this.rustType(local.type, fn.loc);
    }
    const params: string[] = [];
    if (fn.captures !== undefined) {
      const shape = this.closureTargets.get(fn.name);
      if (shape === undefined) this.unsupported(`missing closure shape for '${fn.name}'`, fn.loc);
      params.push(`sc_self: runtime::Gc<${this.closureName(shape)}>`);
      for (const capture of fn.captures) {
        params.push(`${mangleLocal(capture.localId)}: runtime::JsCell<${this.rustType(capture.type, fn.loc)}>`);
      }
    }
    params.push(...fn.params.map((param) => {
      const local = fn.locals.find((candidate) => candidate.id === param.localId);
      if (local === undefined) this.unsupported(`missing parameter local '${param.localId}'`, fn.loc);
      const name = local.boxed ? mangleRawParam(param.localId) : mangleLocal(param.localId);
      return `${local.mutable && !local.boxed ? "mut " : ""}${name}: ${this.rustType(param.type, fn.loc)}`;
    }));
    const returnType = this.rustType(fn.returnType, fn.loc);
    this.line(`fn ${mangleFunction(fn.name)}(${params.join(", ")})${returnType === "()" ? "" : ` -> ${returnType}`} {`);
    this.indent += 1;
    this.currentFunction = fn;
    for (const param of fn.params) {
      const local = fn.locals.find((candidate) => candidate.id === param.localId);
      if (local?.boxed) {
        this.line(`let ${mangleLocal(param.localId)} = runtime::cell_new(${mangleRawParam(param.localId)});`);
      }
    }
    this.emitStatements(fn.body);
    if (fn.returnType.kind !== "void") {
      this.line(`unreachable!("scriptc invariant: function '${this.rustString(fn.name)}' fell through")`);
    }
    this.currentFunction = null;
    this.indent -= 1;
    this.line("}");
  }

  private emitStatements(statements: readonly IrStmt[]): void {
    for (const stmt of statements) this.emitStatement(stmt);
  }

  private emitStatement(stmt: IrStmt): void {
    switch (stmt.kind) {
      case "varDecl": {
        const local = this.local(stmt.localId, stmt.loc);
        if (local.boxed) {
          const init = stmt.init === null
            ? "runtime::cell_empty()"
            : `runtime::cell_new(${this.emitExpr(stmt.init)})`;
          this.line(`let ${local.mutable ? "mut " : ""}${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = ${init};`);
          return;
        }
        const mutable = local.mutable ? "mut " : "";
        const init = stmt.init === null
          ? this.defaultValue(local.type, stmt.loc)
          : this.emitExpr(stmt.init);
        this.line(`let ${mutable}${mangleLocal(local.id)}: ${this.rustType(local.type, stmt.loc)} = ${init};`);
        return;
      }
      case "assign":
        this.emitAssignment(stmt.localId, this.emitExpr(stmt.value), stmt.loc);
        return;
      case "exprStmt":
        this.line(`let _ = ${this.emitExpr(stmt.expr)};`);
        return;
      case "if":
        this.line(`if ${this.emitExpr(stmt.cond)} {`);
        this.indent += 1;
        this.emitStatements(stmt.then);
        this.indent -= 1;
        if (stmt.else_ === null) {
          this.line("}");
        } else {
          this.line("} else {");
          this.indent += 1;
          this.emitStatements(stmt.else_);
          this.indent -= 1;
          this.line("}");
        }
        return;
      case "while":
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled while", stmt.loc);
        {
          const loopLabel = `sc_loop_${this.temporary++}`;
          this.line(`'${loopLabel}: while ${this.emitExpr(stmt.cond)} {`);
          this.indent += 1;
          this.loopTargets.push({ id: this.nextLoopTargetId++, breakLabel: loopLabel, continueBlock: null });
          this.emitStatements(stmt.body);
          this.loopTargets.pop();
          this.indent -= 1;
          this.line("}");
        }
        return;
      case "for":
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled for", stmt.loc);
        this.line("{");
        this.indent += 1;
        if (stmt.init !== null) this.emitStatement(stmt.init);
        const loopLabel = `sc_loop_${this.temporary++}`;
        this.line(`'${loopLabel}: while ${stmt.cond === null ? "true" : this.emitExpr(stmt.cond)} {`);
        this.indent += 1;
        const continueTarget = `sc_continue_${this.temporary++}`;
        this.line(`'${continueTarget}: {`);
        this.indent += 1;
        this.loopTargets.push({ id: this.nextLoopTargetId++, breakLabel: loopLabel, continueBlock: continueTarget });
        this.emitStatements(stmt.body);
        this.loopTargets.pop();
        this.indent -= 1;
        this.line("}");
        if (stmt.init?.kind === "varDecl") {
          const initLocal = this.local(stmt.init.localId, stmt.loc);
          if (initLocal.boxed) {
            const name = mangleLocal(initLocal.id);
            this.line(`${name} = runtime::cell_new(runtime::cell_get(&${name}));`);
          }
        }
        if (stmt.update !== null) this.emitStatement(stmt.update);
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        return;
      case "forOf": {
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled for-of", stmt.loc);
        if (stmt.iterable.type.kind !== "array") this.unsupported("for-of over a non-array", stmt.loc);
        const local = this.local(stmt.localId, stmt.loc);
        const array = `sc_rt_${this.temporary++}`;
        const index = `sc_rt_${this.temporary++}`;
        const loopLabel = `sc_loop_${this.temporary++}`;
        const continueTarget = `sc_continue_${this.temporary++}`;
        this.line("{");
        this.indent += 1;
        this.line(`let ${array} = ${this.emitExpr(stmt.iterable)};`);
        this.line(`let mut ${index} = 0.0_f64;`);
        this.line(`'${loopLabel}: while ${index} < runtime::array_len(&${array}) {`);
        this.indent += 1;
        this.line(`'${continueTarget}: {`);
        this.indent += 1;
        this.line(local.boxed
          ? `let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`
          : `let ${mangleLocal(local.id)}: ${this.rustType(local.type, stmt.loc)} = runtime::array_get(&${array}, ${index});`);
        this.loopTargets.push({ id: this.nextLoopTargetId++, breakLabel: loopLabel, continueBlock: continueTarget });
        this.emitStatements(stmt.body);
        this.loopTargets.pop();
        this.indent -= 1;
        this.line("}");
        this.line(`${index} += 1.0_f64;`);
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        return;
      }
      case "arraySet": {
        if (stmt.arr.type.kind !== "array") this.unsupported("arraySet on a non-array", stmt.loc);
        const array = `sc_rt_${this.temporary++}`;
        const index = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        this.line(`{ let ${array} = ${this.emitExpr(stmt.arr)}; let ${index} = ${this.emitExpr(stmt.index)}; let ${value} = ${this.emitExpr(stmt.value)}; runtime::array_set(&${array}, ${index}, ${value}); }`);
        return;
      }
      case "recordSet": {
        const shape = this.records.get(stmt.shapeId);
        const field = shape?.fields.find((candidate) => candidate.name === stmt.field);
        if (shape === undefined || field === undefined) this.unsupported(`unknown record field '${stmt.shapeId}.${stmt.field}'`, stmt.loc);
        const object = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        const stored = this.isEdgeValue(field.type) ? `Some(${value})` : value;
        this.line(`{ let ${object} = ${this.emitExpr(stmt.obj)}; let ${value} = ${this.emitExpr(stmt.value)}; ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`);
        return;
      }
      case "throw":
        this.line(`runtime::throw_value(${this.emitExpr(stmt.value)});`);
        return;
      case "rethrow":
        this.line(`runtime::rethrow_caught(${this.emitRead(stmt.localId, { kind: "caught" }, stmt.loc)});`);
        return;
      case "return": {
        const value = stmt.value === null ? "()" : this.emitExpr(stmt.value);
        this.line(this.capturedReturnDepth > 0
          ? `return runtime::Completion::Return(${value});`
          : stmt.value === null ? "return;" : `return ${value};`);
        return;
      }
      case "break":
        if (stmt.label !== undefined) this.unsupported("labeled break", stmt.loc);
        {
          const target = this.loopTargets.at(-1);
          if (target === undefined) this.unsupported("break outside a Rust-supported loop", stmt.loc);
          this.line(this.crossesCompletionBoundary(target)
            ? `return runtime::Completion::Break(${target.id});`
            : `break '${target.breakLabel};`);
        }
        return;
      case "continue":
        if (stmt.label !== undefined) this.unsupported("labeled continue", stmt.loc);
        {
          const target = this.loopTargets.at(-1);
          if (target === undefined) this.unsupported("continue outside a Rust-supported loop", stmt.loc);
          if (this.crossesCompletionBoundary(target)) {
            this.line(`return runtime::Completion::Continue(${target.id});`);
          } else {
            this.line(target.continueBlock === null
              ? `continue '${target.breakLabel};`
              : `break '${target.continueBlock};`);
          }
        }
        return;
      case "block":
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled block", stmt.loc);
        this.line("{");
        this.indent += 1;
        this.emitStatements(stmt.body);
        this.indent -= 1;
        this.line("}");
        return;
      case "tryCatch":
        this.emitTryCatch(stmt);
        return;
      case "runtimeFence":
        // TypeScript lowering appends SC9002 after paths it proved cannot
        // fall through (for example, while(true) with a return). It remains
        // a loud invariant if frontend and backend ever disagree. Deferred
        // JavaScript fences need the future catchable-exception runtime.
        if (stmt.code !== "SC9002") this.unsupported(`runtime fence '${stmt.code}'`, stmt.loc);
        this.line(`panic!("${this.rustString(`${stmt.code}: ${stmt.message}`)}");`);
        return;
      default:
        this.unsupported(`statement '${stmt.kind}'`, stmt.loc);
    }
  }

  private emitTryCatch(stmt: Extract<IrStmt, { kind: "tryCatch" }>): void {
    const fn = this.currentFunction;
    if (fn === null) this.unsupported("try/catch outside a function", stmt.loc);
    let pending = `sc_rt_${this.temporary++}`;
    const payload = `sc_rt_${this.temporary++}`;
    this.line(`let ${pending} = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
    this.indent += 1;
    this.completionLoopBoundaries.push(this.loopTargets.length);
    this.capturedReturnDepth += 1;
    this.emitStatements(stmt.tryBody);
    this.capturedReturnDepth -= 1;
    this.completionLoopBoundaries.pop();
    this.line(`runtime::Completion::<${this.rustType(fn.returnType, stmt.loc)}>::Normal`);
    this.indent -= 1;
    this.line("})) {");
    this.indent += 1;
    this.line("Ok(completion) => completion,");
    this.line(`Err(${payload}) => runtime::Completion::Throw(runtime::caught_from_panic(${payload})),`);
    this.indent -= 1;
    this.line("};");
    if (stmt.catchBody !== null) {
      const nextPending = `sc_rt_${this.temporary++}`;
      const caught = `sc_rt_${this.temporary++}`;
      const catchPayload = `sc_rt_${this.temporary++}`;
      this.line(`let ${nextPending} = match ${pending} {`);
      this.indent += 1;
      this.line(`runtime::Completion::Throw(${caught}) => {`);
      this.indent += 1;
      this.line("match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
      this.indent += 1;
      if (stmt.catchLocalId === null) {
        this.line(`let _ = ${caught};`);
      } else {
        const local = this.local(stmt.catchLocalId, stmt.loc);
        this.line(`let ${mangleLocal(local.id)}: runtime::Caught = ${caught};`);
      }
      this.completionLoopBoundaries.push(this.loopTargets.length);
      this.capturedReturnDepth += 1;
      this.emitStatements(stmt.catchBody);
      this.capturedReturnDepth -= 1;
      this.completionLoopBoundaries.pop();
      this.line(`runtime::Completion::<${this.rustType(fn.returnType, stmt.loc)}>::Normal`);
      this.indent -= 1;
      this.line("})) {");
      this.indent += 1;
      this.line("Ok(completion) => completion,");
      this.line(`Err(${catchPayload}) => runtime::Completion::Throw(runtime::caught_from_panic(${catchPayload})),`);
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("},");
      this.line("completion => completion,");
      this.indent -= 1;
      this.line("};");
      pending = nextPending;
    }
    if (stmt.finallyBody !== null) {
      const finalResult = `sc_rt_${this.temporary++}`;
      const finalPayload = `sc_rt_${this.temporary++}`;
      this.line(`let ${finalResult} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
      this.indent += 1;
      this.completionLoopBoundaries.push(this.loopTargets.length);
      this.emitStatements(stmt.finallyBody);
      this.completionLoopBoundaries.pop();
      this.indent -= 1;
      this.line("}));");
      this.line(`if let Err(${finalPayload}) = ${finalResult} {`);
      this.indent += 1;
      this.line(`runtime::rethrow_caught(runtime::caught_from_panic(${finalPayload}));`);
      this.indent -= 1;
      this.line("}");
    }
    this.line(`match ${pending} {`);
    this.indent += 1;
    this.line("runtime::Completion::Normal => {},");
    this.line("runtime::Completion::Return(value) => {");
    this.indent += 1;
    this.line(this.capturedReturnDepth > 0
      ? "return runtime::Completion::Return(value);"
      : "return value;");
    this.indent -= 1;
    this.line("},");
    this.line("runtime::Completion::Throw(caught) => runtime::rethrow_caught(caught),");
    for (const target of this.loopTargets) {
      this.line(`runtime::Completion::Break(${target.id}) => break '${target.breakLabel},`);
      this.line(`runtime::Completion::Continue(${target.id}) => ${target.continueBlock === null
        ? `continue '${target.breakLabel}`
        : `break '${target.continueBlock}`},`);
    }
    this.line("runtime::Completion::Break(_) | runtime::Completion::Continue(_) => unreachable!(\"scriptc invariant: unknown completion target\"),");
    this.indent -= 1;
    this.line("}");
  }

  private emitExpr(expr: IrExpr): string {
    switch (expr.kind) {
      case "numLit":
        return this.numberLiteral(expr.value);
      case "strLit":
        return `runtime::string("${this.rustString(expr.value)}")`;
      case "boolLit":
        return expr.value ? "true" : "false";
      case "varRef":
        return this.emitRead(expr.localId, expr.type, expr.loc);
      case "bin":
        return this.emitBinary(expr);
      case "unary": {
        const operand = this.emitExpr(expr.operand);
        if (expr.op === "-") return `(-(${operand}))`;
        if (expr.op === "!") return `(!(${operand}))`;
        return `runtime::bit_not(${operand})`;
      }
      case "logical": {
        const temp = `sc_rt_${this.temporary++}`;
        const left = this.emitExpr(expr.left);
        const truthy = this.truthiness(temp, expr.left.type, expr.loc);
        const takeRight = expr.op === "&&" ? truthy : `!(${truthy})`;
        return `{ let ${temp} = ${left}; if ${takeRight} { ${this.emitExpr(expr.right)} } else { ${temp} } }`;
      }
      case "toBool": {
        const operand = this.emitExpr(expr.operand);
        const temp = `sc_rt_${this.temporary++}`;
        return `{ let ${temp} = ${operand}; ${this.truthiness(temp, expr.operand.type, expr.loc)} }`;
      }
      case "strConcat":
        return `runtime::string_concat(&(${this.emitExpr(expr.left)}), &(${this.emitExpr(expr.right)}))`;
      case "strIntrinsic":
        if (expr.method === "length") return `runtime::string_len(&(${this.emitExpr(expr.receiver)}))`;
        if (expr.method === "toLowerCase" && expr.args.length === 0) {
          return `runtime::string_to_lower_case(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "repeat" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_repeat(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        this.unsupported(`string intrinsic '${expr.method}'`, expr.loc);
      case "strEq": {
        const compare = `(${this.emitExpr(expr.left)}).as_ref() == (${this.emitExpr(expr.right)}).as_ref()`;
        return expr.negated ? `!(${compare})` : `(${compare})`;
      }
      case "strCmp": {
        if (expr.utf16) this.unsupported("UTF-16 string comparison", expr.loc);
        return `((${this.emitExpr(expr.left)}).as_ref() ${expr.op} (${this.emitExpr(expr.right)}).as_ref())`;
      }
      case "toString": {
        const operand = this.emitExpr(expr.operand);
        if (expr.operand.type.kind === "f64") return `runtime::number_to_string(${operand})`;
        if (expr.operand.type.kind === "bool") return `runtime::bool_to_string(${operand})`;
        this.unsupported(`toString from '${expr.operand.type.kind}'`, expr.loc);
      }
      case "ternary":
        return `(if ${this.emitExpr(expr.cond)} { ${this.emitExpr(expr.then)} } else { ${this.emitExpr(expr.else_)} })`;
      case "arrayLit": {
        if (expr.type.kind !== "array") this.unsupported("array literal with a non-array type", expr.loc);
        const array = `sc_rt_${this.temporary++}`;
        const spreadSet = new Set(expr.spreads ?? []);
        const operations = expr.elems.map((element, index) => spreadSet.has(index)
          ? `runtime::array_extend(&${array}, &(${this.emitExpr(element)}));`
          : `runtime::array_push(&${array}, ${this.emitExpr(element)});`).join(" ");
        return `{ let ${array}: ${this.rustType(expr.type, expr.loc)} = runtime::array_new(Vec::new()); ${operations} ${array} }`;
      }
      case "arrayGet":
        if (expr.arr.type.kind !== "array") this.unsupported("arrayGet on a non-array", expr.loc);
        return `runtime::array_get(&(${this.emitExpr(expr.arr)}), ${this.emitExpr(expr.index)})`;
      case "arrIntrinsic":
        return this.emitArrayIntrinsic(expr);
      case "recordLit": {
        if (expr.type.kind !== "record") this.unsupported("record literal with a non-record type", expr.loc);
        const shape = this.records.get(expr.type.shapeId);
        if (shape === undefined) this.unsupported(`unknown record shape '${expr.type.shapeId}'`, expr.loc);
        const values = new Map<string, string>();
        const bindings: string[] = [];
        for (const entry of expr.fields) {
          if (entry.overflow || entry.drop) this.unsupported("record overflow/drop fields", expr.loc);
          const temp = `sc_rt_${this.temporary++}`;
          bindings.push(`let ${temp} = ${this.emitExpr(entry.value)};`);
          values.set(entry.name, temp);
        }
        const fields = shape.fields.map((field) => {
          const value = values.get(field.name);
          if (value === undefined) this.unsupported(`missing record field '${shape.id}.${field.name}'`, expr.loc);
          const stored = this.isEdgeValue(field.type) ? `Some(${value})` : value;
          return `${mangleField(field.name)}: ${stored}`;
        }).join(", ");
        return `{ ${bindings.join(" ")} runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} }) }`;
      }
      case "recordGet": {
        const shape = this.records.get(expr.shapeId);
        const field = shape?.fields.find((candidate) => candidate.name === expr.field);
        if (shape === undefined || field === undefined) this.unsupported(`unknown record field '${expr.shapeId}.${expr.field}'`, expr.loc);
        const access = `record.${mangleField(field.name)}`;
        const result = this.isEdgeValue(field.type)
          ? `${access}.as_ref().expect("scriptc: cleared live record field").clone()`
          : this.needsClone(field.type) ? `${access}.clone()` : access;
        return `(${this.emitExpr(expr.obj)}).with(|record| ${result})`;
      }
      case "caughtTest":
        if (expr.test !== "instanceof" || expr.className !== "%Error") {
          this.unsupported(`caught test '${expr.test}:${expr.className ?? ""}'`, expr.loc);
        }
        return `runtime::caught_is_error(&(${this.emitExpr(expr.value)}))`;
      case "caughtNarrow":
        if (expr.type.kind !== "object" || expr.type.className !== "%Error") {
          this.unsupported("caught narrowing outside Error", expr.loc);
        }
        return this.emitExpr(expr.value);
      case "fieldGet":
        if (expr.className === "%Error" && (expr.field === "name" || expr.field === "message")) {
          return `runtime::caught_error_${expr.field}(&(${this.emitExpr(expr.obj)}))`;
        }
        this.unsupported(`field get '${expr.className}.${expr.field}'`, expr.loc);
      case "unionWrap": {
        const union = this.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined) this.unsupported(`unknown union tag '${expr.unionId}:${expr.tag}'`, expr.loc);
        const variant = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}`;
        if (this.isUnit(arm)) return variant;
        return `${variant}(${this.emitExpr(expr.value)})`;
      }
      case "unionNarrow": {
        const union = this.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined || this.isUnit(arm)) this.unsupported(`invalid union narrow '${expr.unionId}:${expr.tag}'`, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        const variant = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}`;
        return `{ let ${value} = ${this.emitExpr(expr.value)}; match ${value} { ${variant}(payload) => payload, _ => unreachable!("scriptc invariant: invalid union narrowing") } }`;
      }
      case "unionDisc": {
        const union = this.union(expr.unionId, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        const arms = union.arms.map((arm, tag) => {
          if (arm.kind !== "record") this.unsupported(`union discriminant arm '${arm.kind}'`, expr.loc);
          const shape = this.records.get(arm.shapeId);
          const field = shape?.fields.find((candidate) => candidate.name === expr.field);
          if (shape === undefined || field === undefined) {
            this.unsupported(`unknown union discriminant field '${arm.shapeId}.${expr.field}'`, expr.loc);
          }
          const access = `record.${mangleField(field.name)}`;
          const result = this.isEdgeValue(field.type)
            ? `${access}.as_ref().expect("scriptc: cleared live union field").clone()`
            : this.needsClone(field.type) ? `${access}.clone()` : access;
          return `${this.unionName(union.id)}::${this.unionVariant(tag)}(payload) => payload.with(|record| ${result})`;
        }).join(", ");
        return `{ let ${value} = ${this.emitExpr(expr.value)}; match &${value} { ${arms} } }`;
      }
      case "unionIsTag": {
        const union = this.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined) this.unsupported(`unknown union tag '${expr.unionId}:${expr.tag}'`, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        const pattern = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}${this.isUnit(arm) ? "" : "(..)"}`;
        const test = `{ let ${value} = ${this.emitExpr(expr.value)}; matches!(${value}, ${pattern}) }`;
        return expr.negated ? `!(${test})` : test;
      }
      case "unionEq": {
        const union = this.union(expr.unionId, expr.loc);
        const left = `sc_rt_${this.temporary++}`;
        const right = `sc_rt_${this.temporary++}`;
        const test = `{ let ${left} = ${this.emitExpr(expr.left)}; let ${right} = ${this.emitExpr(expr.right)}; ${this.unionEqName(union.id)}(&${left}, &${right}, ${expr.sameValue}) }`;
        return expr.negated ? `!(${test})` : test;
      }
      case "closure":
        return this.emitClosure(expr);
      case "callValue":
        return this.emitCallValue(expr);
      case "selfRef": {
        if (this.currentFunction?.captures === undefined) {
          this.unsupported("selfRef outside a lifted closure", expr.loc);
        }
        return "sc_self.clone()";
      }
      case "call": {
        const callee = this.functions.get(expr.callee);
        if (callee === undefined) this.unsupported(`unknown call target '${expr.callee}'`, expr.loc);
        if (callee.captures !== undefined) this.unsupported(`direct call to lifted closure '${callee.name}'`, expr.loc);
        return `${mangleFunction(callee.name)}(${expr.args.map((arg) => this.emitExpr(arg)).join(", ")})`;
      }
      case "libCall": {
        const arg = expr.args[0];
        if (expr.fn === "math.floor" && expr.args.length === 1 && arg !== undefined) {
          return `(${this.emitExpr(arg)}).floor()`;
        }
        this.unsupported(`library call '${expr.fn}'`, expr.loc);
      }
      case "intrinsic":
        if (expr.name !== "console.log" && expr.name !== "console.error") {
          this.unsupported(`intrinsic '${expr.name}'`, expr.loc);
        }
        return `runtime::${expr.name === "console.log" ? "console_log" : "console_error"}(&[${expr.args.map((arg) => this.displayExpr(arg)).join(", ")}])`;
      case "assignExpr": {
        const value = this.emitExpr(expr.value);
        const temp = `sc_rt_${this.temporary++}`;
        const clone = this.needsClone(expr.type) ? `${temp}.clone()` : temp;
        return `{ let ${temp} = ${value}; ${this.assignmentExpr(expr.localId, clone, expr.loc)} ${temp} }`;
      }
      case "incDec": {
        const old = `sc_rt_${this.temporary++}`;
        const next = `sc_rt_${this.temporary++}`;
        const read = this.emitRead(expr.localId, expr.type, expr.loc);
        const operation = expr.op === "+" ? "+" : "-";
        const result = expr.prefix ? next : old;
        return `{ let ${old} = ${read}; let ${next} = ${old} ${operation} 1.0; ${this.assignmentExpr(expr.localId, next, expr.loc)} ${result} }`;
      }
      default:
        this.unsupported(`expression '${expr.kind}'`, expr.loc);
    }
  }

  private emitClosure(expr: Extract<IrExpr, { kind: "closure" }>): string {
    if (expr.type.kind !== "func") this.unsupported("closure with a non-function type", expr.loc);
    const shape = this.closureShapeForType(expr.type, expr.loc);
    const target = this.functions.get(expr.fnName);
    if (target === undefined || this.closureTargets.get(target.name) !== shape) {
      this.unsupported(`unknown closure target '${expr.fnName}'`, expr.loc);
    }
    const targetCaptures = target.captures ?? [];
    if (targetCaptures.length !== expr.captures.length) {
      this.unsupported(`capture arity for '${target.name}'`, expr.loc);
    }
    const variant = `${this.closureName(shape)}::${this.closureVariant(target)}`;
    let payload = variant;
    if (targetCaptures.length > 0) {
      const fields = targetCaptures.map((capture, index) => {
        const localId = expr.captures[index];
        if (localId === undefined) this.unsupported(`missing capture ${index} for '${target.name}'`, expr.loc);
        const local = this.local(localId, expr.loc);
        if (!local.boxed) this.unsupported(`unboxed capture '${local.name}'`, expr.loc);
        return `${this.captureField(index)}: Some(${mangleLocal(localId)}.clone())`;
      }).join(", ");
      payload = `${variant} { ${fields} }`;
    }
    const allocated = `runtime::Gc::new(${payload})`;
    if (target.captures !== undefined) return allocated;
    const slot = mangleFnClosure(target.name);
    const value = `sc_rt_${this.temporary++}`;
    return `${slot}.with(|slot| { let mut slot = slot.borrow_mut(); if let Some(value) = slot.as_ref() { value.clone() } else { let ${value} = ${allocated}; *slot = Some(${value}.clone()); ${value} } })`;
  }

  private emitCallValue(expr: Extract<IrExpr, { kind: "callValue" }>): string {
    if (expr.callee.type.kind !== "func") this.unsupported("callValue with a non-function callee", expr.loc);
    const shape = this.closureShapeForType(expr.callee.type, expr.loc);
    if (expr.args.length !== shape.type.params.length) {
      this.unsupported("callValue argument arity", expr.loc);
    }
    const callee = `sc_rt_${this.temporary++}`;
    const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
    const bindings = [
      `let ${callee} = ${this.emitExpr(expr.callee)};`,
      ...expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`),
    ].join(" ");
    const arms = shape.targets.map((target) => {
      const captures = target.captures ?? [];
      const variant = `${this.closureName(shape)}::${this.closureVariant(target)}`;
      const fields = captures.map((_, index) => this.captureField(index));
      const pattern = fields.length === 0 ? variant : `${variant} { ${fields.join(", ")} }`;
      const callArgs: string[] = [];
      if (target.captures !== undefined) {
        callArgs.push(`${callee}.clone()`);
        callArgs.push(...fields.map((field) =>
          `${field}.as_ref().expect("scriptc: cleared live closure capture").clone()`,
        ));
      }
      callArgs.push(...args);
      return `${pattern} => ${mangleFunction(target.name)}(${callArgs.join(", ")})`;
    }).join(", ");
    return `{ ${bindings} ${callee}.with(|closure| match closure { ${arms} }) }`;
  }

  private emitBinary(expr: Extract<IrExpr, { kind: "bin" }>): string {
    const left = this.emitExpr(expr.left);
    const right = this.emitExpr(expr.right);
    if (this.isTracedHandle(expr.left.type) && (expr.op === "===" || expr.op === "!==")) {
      const compare = `((${left}).ptr_eq(&(${right})))`;
      return expr.op === "!==" ? `!(${compare})` : compare;
    }
    switch (expr.op) {
      case "+": case "-": case "*": case "/": case "%":
      case "<": case "<=": case ">": case ">=": case "===": case "!==":
        return `((${left}) ${expr.op === "===" ? "==" : expr.op === "!==" ? "!=" : expr.op} (${right}))`;
      case "**":
        return `(${left}).powf(${right})`;
      case "&":
        return `runtime::bit_and(${left}, ${right})`;
      case "|":
        return `runtime::bit_or(${left}, ${right})`;
      case "^":
        return `runtime::bit_xor(${left}, ${right})`;
      case "<<":
        return `runtime::shift_left(${left}, ${right})`;
      case ">>":
        return `runtime::shift_right(${left}, ${right})`;
      case ">>>":
        return `runtime::shift_right_unsigned(${left}, ${right})`;
    }
  }

  private displayExpr(expr: IrExpr): string {
    const emitted = this.emitExpr(expr);
    switch (expr.type.kind) {
      case "f64": return `runtime::display_number(${emitted})`;
      case "bool": return `runtime::display_bool(${emitted})`;
      case "string": return `runtime::display_string(&(${emitted}))`;
      default: this.unsupported(`console display type '${expr.type.kind}'`, expr.loc);
    }
  }

  private truthiness(value: string, type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "bool": return value;
      case "f64": return `(${value} != 0.0 && !${value}.is_nan())`;
      case "string": return `!${value}.is_empty()`;
      case "array": return "true";
      case "record": return "true";
      case "func": return "true";
      default: this.unsupported(`truthiness for '${type.kind}'`, loc);
    }
  }

  private emitRead(id: string, type: IrType, loc: SrcLoc): string {
    const global = this.globals.get(id);
    if (global !== undefined) {
      const name = mangleGlobal(id);
      if (this.isHeapRoot(type)) {
        return `${name}.with(|slot| slot.borrow().as_ref().expect("scriptc: uninitialized global").clone())`;
      }
      if (this.needsClone(type)) return `${name}.with(|slot| slot.borrow().clone())`;
      if (type.kind === "f64" || type.kind === "bool") return `${name}.with(Cell::get)`;
      this.unsupported(`global read type '${type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (local.boxed) {
      return local.tdz
        ? `runtime::cell_get_tdz(&${mangleLocal(id)}, "${this.rustString(local.name)}")`
        : `runtime::cell_get(&${mangleLocal(id)})`;
    }
    return this.needsClone(local.type) ? `${mangleLocal(id)}.clone()` : mangleLocal(id);
  }

  private emitAssignment(id: string, value: string, loc: SrcLoc): void {
    this.line(`${this.assignmentExpr(id, value, loc)}`);
  }

  private assignmentExpr(id: string, value: string, loc: SrcLoc): string {
    const global = this.globals.get(id);
    if (global !== undefined) {
      const name = mangleGlobal(id);
      if (this.isHeapRoot(global.type)) return `${name}.with(|slot| *slot.borrow_mut() = Some(${value}));`;
      if (this.needsClone(global.type)) return `${name}.with(|slot| *slot.borrow_mut() = ${value});`;
      if (global.type.kind === "f64" || global.type.kind === "bool") return `${name}.with(|slot| slot.set(${value}));`;
      this.unsupported(`global assignment type '${global.type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (local.boxed) return `runtime::cell_set(&${mangleLocal(id)}, ${value});`;
    return `${mangleLocal(id)} = ${value};`;
  }

  private local(id: string, loc: SrcLoc) {
    const local = this.currentFunction?.locals.find((candidate) => candidate.id === id);
    if (local === undefined) this.unsupported(`unknown local '${id}'`, loc);
    return local;
  }

  private crossesCompletionBoundary(target: { id: number }): boolean {
    const boundary = this.completionLoopBoundaries.at(-1);
    if (boundary === undefined) return false;
    const index = this.loopTargets.findIndex((candidate) => candidate.id === target.id);
    return index >= 0 && index < boundary;
  }

  private rustType(type: IrType, loc?: SrcLoc): string {
    switch (type.kind) {
      case "void": return "()";
      case "f64": return "f64";
      case "bool": return "bool";
      case "string": return "runtime::JsString";
      case "array": return `runtime::JsArray<${this.rustType(type.elem, loc)}>`;
      case "record": {
        if (!this.records.has(type.shapeId)) this.unsupported(`unknown record type '${type.shapeId}'`, loc);
        return `runtime::Gc<${mangleRecordStruct(type.shapeId)}>`;
      }
      case "union": {
        if (!this.unions.has(type.unionId)) this.unsupported(`unknown union type '${type.unionId}'`, loc);
        return this.unionName(type.unionId);
      }
      case "func": {
        const shape = this.closureShapeForType(type, loc);
        return `runtime::Gc<${this.closureName(shape)}>`;
      }
      case "caught": return "runtime::Caught";
      default: this.unsupported(`type '${type.kind}'`, loc);
    }
  }

  private defaultValue(type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64": return "0.0";
      case "bool": return "false";
      case "string": return "runtime::empty_string()";
      case "array": return "runtime::array_new(Vec::new())";
      default: this.unsupported(`uninitialized '${type.kind}' local`, loc);
    }
  }

  private numberLiteral(value: number): string {
    if (Number.isNaN(value)) return "f64::NAN";
    if (value === Infinity) return "f64::INFINITY";
    if (value === -Infinity) return "f64::NEG_INFINITY";
    if (Object.is(value, -0)) return "-0.0_f64";
    const spelling = String(value).replace("e+", "e");
    return Number.isInteger(value) && !spelling.includes("e")
      ? `${spelling}.0_f64`
      : `${spelling}_f64`;
  }

  private emitArrayIntrinsic(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "array") this.unsupported("array intrinsic on a non-array", expr.loc);
    const receiver = `sc_rt_${this.temporary++}`;
    switch (expr.method) {
      case "length":
        return `runtime::array_len(&(${this.emitExpr(expr.receiver)}))`;
      case "pop":
        return `runtime::array_pop(&(${this.emitExpr(expr.receiver)}))`;
      case "push": {
        const values = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const bindings = expr.args.map((arg, index) => `let ${values[index]} = ${this.emitExpr(arg)};`).join(" ");
        const pushes = values.map((value) => `runtime::array_push(&${receiver}, ${value});`).join(" ");
        return `{ let ${receiver} = ${this.emitExpr(expr.receiver)}; ${bindings} ${pushes} runtime::array_len(&${receiver}) }`;
      }
      case "pushSpread": {
        const first = expr.args[0];
        if (first === undefined) this.unsupported("array pushSpread without a source", expr.loc);
        const source = `sc_rt_${this.temporary++}`;
        return `{ let ${receiver} = ${this.emitExpr(expr.receiver)}; let ${source} = ${this.emitExpr(first)}; runtime::array_extend(&${receiver}, &${source}) }`;
      }
      case "join": {
        const separator = expr.args[0];
        if (separator === undefined) this.unsupported("array join without a separator", expr.loc);
        const elem = expr.receiver.type.elem;
        if (elem.kind !== "f64" && elem.kind !== "bool" && elem.kind !== "string") {
          this.unsupported(`array join element '${elem.kind}'`, expr.loc);
        }
        return `runtime::array_join(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(separator)}))`;
      }
      default:
        this.unsupported(`array intrinsic '${expr.method}'`, expr.loc);
    }
  }

  private needsClone(type: IrType): boolean {
    return type.kind === "string" || type.kind === "union" || type.kind === "caught" || this.isTracedHandle(type);
  }

  private isTracedHandle(type: IrType): boolean {
    return type.kind === "array" || type.kind === "record" || type.kind === "func";
  }

  private isEdgeValue(type: IrType): boolean {
    return this.isTracedHandle(type) || type.kind === "union";
  }

  private isHeapRoot(type: IrType): boolean {
    return this.isEdgeValue(type);
  }

  private isUnit(type: IrType): boolean {
    return type.kind === "undefinedT" || type.kind === "nullT";
  }

  private ensureUnionArm(type: IrType): void {
    switch (type.kind) {
      case "f64":
      case "bool":
      case "string":
      case "array":
      case "record":
      case "func":
      case "undefinedT":
      case "nullT":
        return;
      default:
        this.unsupported(`union arm '${type.kind}'`);
    }
  }

  private closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape {
    const shape = this.closureShapes.get(typeKey(type));
    if (shape === undefined) this.unsupported(`function signature '${typeKey(type)}' without closure targets`, loc);
    return shape;
  }

  private closureName(shape: RustClosureShape): string {
    return `sc_closure_${shape.index}`;
  }

  private closureVariant(target: IrFunction): string {
    const index = this.mod.functions.indexOf(target);
    if (index < 0) this.unsupported(`unknown closure function '${target.name}'`, target.loc);
    return `ScFn${index}`;
  }

  private captureField(index: number): string {
    return `sc_cap_${index}`;
  }

  private union(id: string, loc?: SrcLoc): IrUnionDef {
    const union = this.unions.get(id);
    if (union === undefined) this.unsupported(`unknown union '${id}'`, loc);
    return union;
  }

  private unionName(id: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(id)) this.unsupported(`invalid union id '${id}'`);
    return `sc_u_${id}`;
  }

  private unionVariant(tag: number): string {
    return `ScArm${tag}`;
  }

  private unionEqName(id: string): string {
    return `sc_union_eq_${id}`;
  }

  private rustString(value: string): string {
    let result = "";
    for (const char of value) {
      switch (char) {
        case "\\": result += "\\\\"; break;
        case "\"": result += "\\\""; break;
        case "\n": result += "\\n"; break;
        case "\r": result += "\\r"; break;
        case "\t": result += "\\t"; break;
        case "\0": result += "\\0"; break;
        default: {
          const code = char.codePointAt(0) ?? 0;
          result += code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : char;
        }
      }
    }
    return result;
  }

  private line(value: string): void {
    this.lines.push(`${"    ".repeat(this.indent)}${value}`);
  }

  private unsupported(kind: string, loc?: SrcLoc): never {
    throw new RustUnsupportedError(kind, loc);
  }
}
