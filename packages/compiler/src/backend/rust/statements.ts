import type { IrClassDef, IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import { mangleField, mangleLocal } from "../mangle.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";

export interface RustLoopTarget {
  readonly id: number;
  readonly kind: "loop" | "switch" | "block";
  readonly labels: readonly string[] | undefined;
  readonly breakLabel: string;
  readonly continueBlock: string | null;
  readonly allowsContinue: boolean;
}

export interface RustStatementContext {
  readonly loopTargets: RustLoopTarget[];
  readonly completionLoopBoundaries: number[];
  capturedReturnDepth(): number;
  adjustCapturedReturnDepth(delta: number): void;
  asyncProtectedReturnDepth(): number;
  currentAsyncResult(): string | null;
  currentFunction(): IrFunction | null;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  nextLabel(prefix: "sc_loop" | "sc_continue" | "sc_switch" | "sc_block"): string;
  nextLoopTargetId(): number;
  dynTypeName(): string;
  emitExpr(expr: IrExpr): string;
  emitRead(id: string, type: IrType, loc: SrcLoc): string;
  emitAssignment(id: string, value: string, loc: SrcLoc): void;
  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string;
  local(id: string, loc: SrcLoc): IrFunction["locals"][number];
  localIsBoxed(local: IrFunction["locals"][number]): boolean;
  forceBoxedLocal(id: string, forced: boolean): void;
  rustType(type: IrType, loc?: SrcLoc): string;
  record(shapeId: string): IrRecordShape | undefined;
  classDef(name: string, loc?: SrcLoc): IrClassDef;
  classFieldName(className: string, fieldName: string, loc?: SrcLoc): string;
  isEdgeValue(type: IrType): boolean;
  rustString(value: string): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export function emitRustStatements(
  statements: readonly IrStmt[],
  context: RustStatementContext,
): void {
  new RustStatementEmitter(context).emit(statements);
}

class RustStatementEmitter {
  private readonly predeclaredLocals = new Set<string>();

  constructor(private readonly context: RustStatementContext) {}

  emit(statements: readonly IrStmt[]): void {
    for (const statement of statements) this.emitStatement(statement);
  }

  private emitStatement(stmt: IrStmt): void {
    switch (stmt.kind) {
      case "varDecl": {
        const local = this.context.local(stmt.localId, stmt.loc);
        if (this.predeclaredLocals.has(local.id)) {
          if (stmt.init !== null) {
            this.context.line(`runtime::cell_set(&${mangleLocal(local.id)}, ${this.context.emitExpr(stmt.init)});`);
          }
          return;
        }
        if (stmt.init === null && local.type.kind === "func") {
          this.context.forceBoxedLocal(local.id, true);
        }
        if (this.context.localIsBoxed(local)) {
          const init = stmt.init === null
            ? "runtime::cell_empty()"
            : `runtime::cell_new(${this.context.emitExpr(stmt.init)})`;
          this.context.line(`let ${local.mutable ? "mut " : ""}${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = ${init};`);
          return;
        }
        const mutable = local.mutable ? "mut " : "";
        const type = this.context.rustType(local.type, stmt.loc);
        if (stmt.init === null) {
          this.context.line(`let ${mutable}${mangleLocal(local.id)}: ${type};`);
          return;
        }
        this.context.line(`let ${mutable}${mangleLocal(local.id)}: ${type} = ${this.context.emitExpr(stmt.init)};`);
        return;
      }
      case "assign":
        this.context.emitAssignment(stmt.localId, this.context.emitExpr(stmt.value), stmt.loc);
        return;
      case "exprStmt":
        this.context.line(`let _ = ${this.context.emitExpr(stmt.expr)};`);
        return;
      case "if":
        this.context.line(`if ${this.context.emitExpr(stmt.cond)} {`);
        this.context.pushIndent();
        this.emit(stmt.then);
        this.context.popIndent();
        if (stmt.else_ === null) {
          this.context.line("}");
        } else {
          this.context.line("} else {");
          this.context.pushIndent();
          this.emit(stmt.else_);
          this.context.popIndent();
          this.context.line("}");
        }
        return;
      case "while":
        this.emitWhile(stmt);
        return;
      case "doWhile":
        this.emitDoWhile(stmt);
        return;
      case "switch":
        this.emitSwitch(stmt);
        return;
      case "for":
        this.emitFor(stmt);
        return;
      case "forOf":
        this.emitForOf(stmt);
        return;
      case "arraySet": {
        if (stmt.arr.type.kind !== "array") this.context.unsupported("arraySet on a non-array", stmt.loc);
        const array = this.context.nextTemporary();
        const index = this.context.nextTemporary();
        const value = this.context.nextTemporary();
        this.context.line(`{ let ${array} = ${this.context.emitExpr(stmt.arr)}; let ${index} = ${this.context.emitExpr(stmt.index)}; let ${value} = ${this.context.emitExpr(stmt.value)}; runtime::array_set(&${array}, ${index}, ${value}); }`);
        return;
      }
      case "bytesSet": {
        if (stmt.arr.type.kind !== "bytes") this.context.unsupported("bytesSet on non-bytes", stmt.loc);
        const bytes = this.context.nextTemporary();
        const index = this.context.nextTemporary();
        const value = this.context.nextTemporary();
        this.context.line(`{ let ${bytes} = ${this.context.emitExpr(stmt.arr)}; let ${index} = ${this.context.emitExpr(stmt.index)}; let ${value} = ${this.context.emitExpr(stmt.value)}; runtime::bytes_set(&${bytes}, ${index}, ${value}); }`);
        return;
      }
      case "recordKeySet":
        this.emitRecordKeySet(stmt);
        return;
      case "recordKeyDelete":
        this.emitRecordKeyDelete(stmt);
        return;
      case "recordSet":
        this.emitRecordSet(stmt);
        return;
      case "fieldSet":
        this.emitFieldSet(stmt);
        return;
      case "throw":
        this.context.line(`runtime::throw_value(${this.context.emitExpr(stmt.value)});`);
        return;
      case "rethrow":
        this.context.line(`runtime::rethrow_caught(${this.context.emitRead(stmt.localId, { kind: "caught" }, stmt.loc)});`);
        return;
      case "return":
        this.emitReturn(stmt);
        return;
      case "break":
        this.emitBreak(stmt);
        return;
      case "continue":
        this.emitContinue(stmt);
        return;
      case "block":
        if ((stmt.labels?.length ?? 0) === 0) {
          this.context.line("{");
          this.context.pushIndent();
          this.emit(stmt.body);
          this.context.popIndent();
          this.context.line("}");
          return;
        }
        {
          const blockLabel = this.context.nextLabel("sc_block");
          this.context.line(`'${blockLabel}: {`);
          this.context.pushIndent();
          this.context.loopTargets.push({
            id: this.context.nextLoopTargetId(),
            kind: "block",
            labels: stmt.labels,
            breakLabel: blockLabel,
            continueBlock: null,
            allowsContinue: false,
          });
          this.emit(stmt.body);
          this.context.loopTargets.pop();
          this.context.popIndent();
          this.context.line("}");
        }
        return;
      case "tryCatch":
        this.emitTryCatch(stmt);
        return;
      case "runtimeFence":
        this.emitRuntimeFence(stmt);
        return;
      default:
        {
          const exhaustive: never = stmt;
          void exhaustive;
        }
    }
  }

  private emitWhile(stmt: Extract<IrStmt, { kind: "while" }>): void {
    const loopLabel = this.context.nextLabel("sc_loop");
    this.context.line(`'${loopLabel}: while ${this.context.emitExpr(stmt.cond)} {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: null,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
  }

  private emitDoWhile(stmt: Extract<IrStmt, { kind: "doWhile" }>): void {
    const loopLabel = this.context.nextLabel("sc_loop");
    const continueTarget = this.context.nextLabel("sc_continue");
    this.context.line(`'${loopLabel}: loop {`);
    this.context.pushIndent();
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: continueTarget,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`if !(${this.context.emitExpr(stmt.cond)}) { break '${loopLabel}; }`);
    this.context.popIndent();
    this.context.line("}");
  }

  private emitFor(stmt: Extract<IrStmt, { kind: "for" }>): void {
    this.context.line("{");
    this.context.pushIndent();
    if (stmt.init !== null) this.emitStatement(stmt.init);
    const loopLabel = this.context.nextLabel("sc_loop");
    this.context.line(`'${loopLabel}: while ${stmt.cond === null ? "true" : this.context.emitExpr(stmt.cond)} {`);
    this.context.pushIndent();
    const continueTarget = this.context.nextLabel("sc_continue");
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: continueTarget,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    if (stmt.init?.kind === "varDecl") {
      const initLocal = this.context.local(stmt.init.localId, stmt.loc);
      if (this.context.localIsBoxed(initLocal)) {
        const name = mangleLocal(initLocal.id);
        this.context.line(`${name} = runtime::cell_new(runtime::cell_get(&${name}));`);
      }
    }
    if (stmt.update !== null) this.emitStatement(stmt.update);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitForOf(stmt: Extract<IrStmt, { kind: "forOf" }>): void {
    if (stmt.iterable.type.kind === "generator") {
      this.emitGeneratorForOf(stmt);
      return;
    }
    if (stmt.iterable.type.kind !== "array") this.context.unsupported("for-of over a non-array", stmt.loc);
    const local = this.context.local(stmt.localId, stmt.loc);
    const array = this.context.nextTemporary();
    const index = this.context.nextTemporary();
    const loopLabel = this.context.nextLabel("sc_loop");
    const continueTarget = this.context.nextLabel("sc_continue");
    this.context.line("{");
    this.context.pushIndent();
    this.context.line(`let ${array} = ${this.context.emitExpr(stmt.iterable)};`);
    this.context.line(`let mut ${index} = 0.0_f64;`);
    this.context.line(`'${loopLabel}: while ${index} < runtime::array_len(&${array}) {`);
    this.context.pushIndent();
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.line(this.context.localIsBoxed(local)
      ? `let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`
      : `let ${mangleLocal(local.id)}: ${this.context.rustType(local.type, stmt.loc)} = runtime::array_get(&${array}, ${index});`);
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: continueTarget,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`${index} += 1.0_f64;`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitGeneratorForOf(stmt: Extract<IrStmt, { kind: "forOf" }>): void {
    if (stmt.iterable.type.kind !== "generator") this.context.unsupported("generator for-of shape", stmt.loc);
    const type = stmt.iterable.type;
    const local = this.context.local(stmt.localId, stmt.loc);
    const generator = this.context.nextTemporary();
    const item = this.context.nextTemporary();
    const loopLabel = this.context.nextLabel("sc_loop");
    const continueTarget = this.context.nextLabel("sc_continue");
    const next = type.nextT.kind === "dyn" ? `${this.context.dynTypeName()}::Undefined`
      : type.nextT.kind === "undefinedT" || type.nextT.kind === "void" || type.nextT.kind === "nullT" ? "()"
      : this.context.unsupported("generator for-of with a required next value", stmt.loc);
    this.context.line("{");
    this.context.pushIndent();
    this.context.line(`let ${generator} = ${this.context.emitExpr(stmt.iterable)};`);
    this.context.line(`'${loopLabel}: loop {`);
    this.context.pushIndent();
    this.context.line(`let ${item} = match runtime::generator_next(&${generator}, ${next}) {`);
    this.context.pushIndent();
    this.context.line("runtime::GeneratorStep::Yielded(value) => value,");
    this.context.line(`runtime::GeneratorStep::Returned(_) => break '${loopLabel},`);
    this.context.popIndent();
    this.context.line("};");
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.line(this.context.localIsBoxed(local)
      ? `let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(${item});`
      : `let ${mangleLocal(local.id)}: ${this.context.rustType(local.type, stmt.loc)} = ${item};`);
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(), kind: "loop", labels: stmt.labels,
      breakLabel: loopLabel, continueBlock: continueTarget, allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitRecordKeySet(stmt: Extract<IrStmt, { kind: "recordKeySet" }>): void {
    const shape = this.context.record(stmt.shapeId);
    if (shape === undefined) this.context.unsupported(`keyed write on unknown record '${stmt.shapeId}'`, stmt.loc);
    const indexValue = shape.indexValue ?? shape.fields[0]?.type;
    if (indexValue === undefined || (shape.indexValue === undefined &&
      (stmt.overflowOnly === true || !shape.fields.every((field) => typeKey(field.type) === typeKey(indexValue))))) {
      this.context.unsupported(`keyed write on non-indexed record '${stmt.shapeId}'`, stmt.loc);
    }
    if (stmt.key.type.kind !== "string" || typeKey(stmt.value.type) !== typeKey(indexValue)) {
      this.context.unsupported(`keyed write types for record '${stmt.shapeId}'`, stmt.loc);
    }
    const object = this.context.nextTemporary();
    const key = this.context.nextTemporary();
    const value = this.context.nextTemporary();
    const bindings = `let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${key} = ${this.context.emitExpr(stmt.key)}; let ${value} = ${this.context.emitExpr(stmt.value)};`;
    if (shape.indexValue === undefined) {
      const declared = shape.fields.map((field, index) => {
        const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
        return `${index === 0 ? "if" : "else if"} ${key}.as_ref() == "${this.context.rustString(field.name)}" { ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`;
      }).join(" ");
      this.context.line(`{ ${bindings} ${declared} else { runtime::throw_type_error(format!("Cannot add property '{}' to a fixed-shape object", ${key})); } }`);
      return;
    }
    if (shape.fields.length === 0) {
      this.context.line(`{ ${bindings} runtime::map_set_by(&${object}, ${key}, ${value}, |left, right| left.as_ref() == right.as_ref()); }`);
      return;
    }
    const declared = (stmt.overflowOnly ? [] : shape.fields).map((field, index) => {
      const checked = indexValue.kind === "dyn"
        ? this.context.emitDynCheckValue(field.type, value, stmt.loc)
        : value;
      const stored = this.context.isEdgeValue(field.type) ? `Some(${checked})` : checked;
      return `${index === 0 ? "if" : "else if"} ${key}.as_ref() == "${this.context.rustString(field.name)}" { ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`;
    });
    const overflow = `${object}.with(|record| record.${RUST_RECORD_OVERFLOW}.as_ref().expect("scriptc: cleared live record overflow").clone())`;
    const setOverflow = `let overflow = ${overflow}; runtime::map_set_by(&overflow, ${key}, ${value}, |left, right| left.as_ref() == right.as_ref());`;
    const dispatch = declared.length === 0
      ? setOverflow
      : `${declared.join(" ")} else { ${setOverflow} }`;
    this.context.line(`{ ${bindings} ${dispatch} }`);
  }

  private emitRecordKeyDelete(stmt: Extract<IrStmt, { kind: "recordKeyDelete" }>): void {
    const shape = this.context.record(stmt.shapeId);
    if (shape?.indexValue === undefined || shape.fields.length !== 0 || stmt.key.type.kind !== "string") {
      this.context.unsupported(`keyed delete on non-indexed record '${stmt.shapeId}'`, stmt.loc);
    }
    const object = this.context.nextTemporary();
    const key = this.context.nextTemporary();
    this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${key} = ${this.context.emitExpr(stmt.key)}; let _ = runtime::map_delete_by(&${object}, &${key}, |left, right| left.as_ref() == right.as_ref()); }`);
  }

  private emitRecordSet(stmt: Extract<IrStmt, { kind: "recordSet" }>): void {
    const shape = this.context.record(stmt.shapeId);
    const field = shape?.fields.find((candidate) => candidate.name === stmt.field);
    if (shape === undefined || field === undefined) {
      this.context.unsupported(`unknown record field '${stmt.shapeId}.${stmt.field}'`, stmt.loc);
    }
    const object = this.context.nextTemporary();
    const value = this.context.nextTemporary();
    const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
    this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${value} = ${this.context.emitExpr(stmt.value)}; ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`);
  }

  private emitFieldSet(stmt: Extract<IrStmt, { kind: "fieldSet" }>): void {
    const cls = this.context.classDef(stmt.className, stmt.loc);
    const field = cls.fields.find((candidate) => candidate.name === stmt.field);
    if (field === undefined) {
      this.context.unsupported(`unknown class field '${stmt.className}.${stmt.field}'`, stmt.loc);
    }
    const name = this.context.classFieldName(stmt.className, field.name, stmt.loc);
    const object = this.context.nextTemporary();
    const value = this.context.nextTemporary();
    const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
    this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${value} = ${this.context.emitExpr(stmt.value)}; ${object}.with_mut(|object| object.${name} = ${stored}); }`);
  }

  private emitReturn(stmt: Extract<IrStmt, { kind: "return" }>): void {
    const value = stmt.value === null ? "()" : this.context.emitExpr(stmt.value);
    if (this.context.capturedReturnDepth() > 0) {
      this.context.line(`return runtime::Completion::Return(${value});`);
      return;
    }
    if (this.context.asyncProtectedReturnDepth() > 0) {
      this.context.line(`return runtime::AsyncCompletion::Return(${value});`);
      return;
    }
    const asyncResult = this.context.currentAsyncResult();
    if (asyncResult !== null) {
      this.context.line(`let _ = runtime::promise_fulfill(&${asyncResult}, ${value});`);
      this.context.line("return;");
      return;
    }
    this.context.line(stmt.value === null ? "return;" : `return ${value};`);
  }

  private emitBreak(stmt: Extract<IrStmt, { kind: "break" }>): void {
    const label = stmt.label;
    const target = label === undefined
      ? this.context.loopTargets.findLast((candidate) => candidate.kind !== "block")
      : this.context.loopTargets.findLast((candidate) => candidate.labels?.includes(label) === true);
    if (target === undefined) this.context.unsupported("break outside a Rust-supported loop", stmt.loc);
    this.context.line(this.crossesCompletionBoundary(target)
      ? `return runtime::Completion::Break(${target.id});`
      : `break '${target.breakLabel};`);
  }

  private emitContinue(stmt: Extract<IrStmt, { kind: "continue" }>): void {
    const target = this.context.loopTargets.findLast((candidate) =>
      candidate.kind === "loop" && (stmt.label === undefined || candidate.labels?.includes(stmt.label) === true)
    );
    if (target === undefined) this.context.unsupported("continue outside a Rust-supported loop", stmt.loc);
    if (this.crossesCompletionBoundary(target)) {
      this.context.line(`return runtime::Completion::Continue(${target.id});`);
    } else {
      this.context.line(target.continueBlock === null
        ? `continue '${target.breakLabel};`
        : `break '${target.continueBlock};`);
    }
  }

  private crossesCompletionBoundary(target: RustLoopTarget): boolean {
    const boundary = this.context.completionLoopBoundaries.at(-1);
    if (boundary === undefined) return false;
    const index = this.context.loopTargets.findIndex((candidate) => candidate.id === target.id);
    return index >= 0 && index < boundary;
  }

  private emitTryCatch(stmt: Extract<IrStmt, { kind: "tryCatch" }>): void {
    const fn = this.context.currentFunction();
    if (fn === null) this.context.unsupported("try/catch outside a function", stmt.loc);
    let pending = this.context.nextTemporary();
    const payload = this.context.nextTemporary();
    this.context.line(`let ${pending} = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
    this.context.pushIndent();
    this.context.completionLoopBoundaries.push(this.context.loopTargets.length);
    this.context.adjustCapturedReturnDepth(1);
    this.emit(stmt.tryBody);
    this.context.adjustCapturedReturnDepth(-1);
    this.context.completionLoopBoundaries.pop();
    this.context.line(`runtime::Completion::<${this.context.rustType(fn.returnType, stmt.loc)}>::Normal`);
    this.context.popIndent();
    this.context.line("})) {");
    this.context.pushIndent();
    this.context.line("Ok(completion) => completion,");
    this.context.line(`Err(${payload}) => runtime::Completion::Throw(runtime::caught_from_panic(${payload})),`);
    this.context.popIndent();
    this.context.line("};");
    if (stmt.catchBody !== null) pending = this.emitCatch(stmt, pending, fn.returnType);
    if (stmt.finallyBody !== null) this.emitFinally(stmt.finallyBody);
    this.emitPendingCompletion(pending);
  }

  private emitCatch(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    pending: string,
    returnType: IrType,
  ): string {
    const nextPending = this.context.nextTemporary();
    const caught = this.context.nextTemporary();
    const catchPayload = this.context.nextTemporary();
    this.context.line(`let ${nextPending} = match ${pending} {`);
    this.context.pushIndent();
    this.context.line(`runtime::Completion::Throw(${caught}) => {`);
    this.context.pushIndent();
    this.context.line("match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
    this.context.pushIndent();
    if (stmt.catchLocalId === null) {
      this.context.line(`let _ = ${caught};`);
    } else {
      const local = this.context.local(stmt.catchLocalId, stmt.loc);
      this.context.line(this.context.localIsBoxed(local)
        ? `let ${mangleLocal(local.id)}: runtime::JsCell<runtime::Caught> = runtime::cell_new(${caught});`
        : `let ${mangleLocal(local.id)}: runtime::Caught = ${caught};`);
    }
    this.context.completionLoopBoundaries.push(this.context.loopTargets.length);
    this.context.adjustCapturedReturnDepth(1);
    this.emit(stmt.catchBody ?? []);
    this.context.adjustCapturedReturnDepth(-1);
    this.context.completionLoopBoundaries.pop();
    this.context.line(`runtime::Completion::<${this.context.rustType(returnType, stmt.loc)}>::Normal`);
    this.context.popIndent();
    this.context.line("})) {");
    this.context.pushIndent();
    this.context.line("Ok(completion) => completion,");
    this.context.line(`Err(${catchPayload}) => runtime::Completion::Throw(runtime::caught_from_panic(${catchPayload})),`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("},");
    this.context.line("completion => completion,");
    this.context.popIndent();
    this.context.line("};");
    return nextPending;
  }

  private emitFinally(statements: readonly IrStmt[]): void {
    const finalResult = this.context.nextTemporary();
    const finalPayload = this.context.nextTemporary();
    this.context.line(`let ${finalResult} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
    this.context.pushIndent();
    this.context.completionLoopBoundaries.push(this.context.loopTargets.length);
    this.emit(statements);
    this.context.completionLoopBoundaries.pop();
    this.context.popIndent();
    this.context.line("}));");
    this.context.line(`if let Err(${finalPayload}) = ${finalResult} {`);
    this.context.pushIndent();
    this.context.line(`runtime::rethrow_caught(runtime::caught_from_panic(${finalPayload}));`);
    this.context.popIndent();
    this.context.line("}");
  }

  private emitPendingCompletion(pending: string): void {
    this.context.line(`match ${pending} {`);
    this.context.pushIndent();
    this.context.line("runtime::Completion::Normal => {},");
    this.context.line("runtime::Completion::Return(value) => {");
    this.context.pushIndent();
    if (this.context.capturedReturnDepth() > 0) {
      this.context.line("return runtime::Completion::Return(value);");
    } else if (this.context.asyncProtectedReturnDepth() > 0) {
      this.context.line("return runtime::AsyncCompletion::Return(value);");
    } else if (this.context.currentAsyncResult() !== null) {
      this.context.line(`let _ = runtime::promise_fulfill(&${this.context.currentAsyncResult()}, value);`);
      this.context.line("return;");
    } else {
      this.context.line("return value;");
    }
    this.context.popIndent();
    this.context.line("},");
    this.context.line("runtime::Completion::Throw(caught) => runtime::rethrow_caught(caught),");
    for (const target of this.context.loopTargets) {
      this.context.line(`runtime::Completion::Break(${target.id}) => break '${target.breakLabel},`);
      if (target.allowsContinue) {
        this.context.line(`runtime::Completion::Continue(${target.id}) => ${target.continueBlock === null
          ? `continue '${target.breakLabel}`
          : `break '${target.continueBlock}`},`);
      }
    }
    this.context.line("runtime::Completion::Break(_) | runtime::Completion::Continue(_) => unreachable!(\"scriptc invariant: unknown completion target\"),");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitRuntimeFence(stmt: Extract<IrStmt, { kind: "runtimeFence" }>): void {
    if (stmt.code === "SC9002") {
      this.context.line(`panic!("${this.context.rustString(`${stmt.code}: ${stmt.message}`)}");`);
    } else {
      this.context.line(`runtime::throw_error_code("${this.context.rustString(stmt.message)}".to_owned(), "${this.context.rustString(stmt.code)}");`);
    }
  }

  private emitSwitch(stmt: Extract<IrStmt, { kind: "switch" }>): void {
    const kind = stmt.disc.type.kind;
    if (kind !== "f64" && kind !== "string" && kind !== "bool") {
      this.context.unsupported(`switch discriminant '${kind}'`, stmt.loc);
    }
    const disc = this.context.nextTemporary();
    const start = this.context.nextTemporary();
    const switchLabel = this.context.nextLabel("sc_switch");
    const defaultIndex = stmt.cases.findIndex((candidate) => candidate.test === null);
    const tests = stmt.cases.flatMap((candidate, index) => {
      if (candidate.test === null) return [];
      if (candidate.test.type.kind !== kind) {
        this.context.unsupported("switch case type mismatch", candidate.test.loc);
      }
      const test = this.context.nextTemporary();
      const equality = kind === "string"
        ? `${disc}.as_ref() == ${test}.as_ref()`
        : `${disc} == ${test}`;
      return [`{ let ${test} = ${this.context.emitExpr(candidate.test)}; if ${equality} { ${index}_i32 } else { `];
    });
    const miss = `${defaultIndex < 0 ? stmt.cases.length : defaultIndex}_i32`;
    this.context.line("{");
    this.context.pushIndent();
    this.context.line(`let ${disc} = ${this.context.emitExpr(stmt.disc)};`);
    this.context.line(`let ${start}: i32 = ${tests.join("")}${miss}${" } }".repeat(tests.length)};`);

    const locals = new Map<string, IrFunction["locals"][number]>();
    for (const candidate of stmt.cases) {
      for (const statement of candidate.body) {
        if (statement.kind !== "varDecl") continue;
        locals.set(statement.localId, this.context.local(statement.localId, statement.loc));
      }
    }
    for (const local of locals.values()) {
      this.predeclaredLocals.add(local.id);
      this.context.forceBoxedLocal(local.id, true);
      this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_empty();`);
    }

    this.context.line(`'${switchLabel}: {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "switch",
      labels: stmt.labels,
      breakLabel: switchLabel,
      continueBlock: null,
      allowsContinue: false,
    });
    stmt.cases.forEach((candidate, index) => {
      this.context.line(`if ${start} <= ${index}_i32 {`);
      this.context.pushIndent();
      this.emit(candidate.body);
      this.context.popIndent();
      this.context.line("}");
    });
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    for (const local of locals.values()) {
      this.predeclaredLocals.delete(local.id);
      this.context.forceBoxedLocal(local.id, false);
    }
    this.context.popIndent();
    this.context.line("}");
  }
}
