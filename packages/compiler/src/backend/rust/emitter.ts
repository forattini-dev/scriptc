import type {
  IrClassDef,
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
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
import {
  mangleClassStruct,
  mangleField,
  mangleFnClosure,
  mangleFunction,
  mangleGlobal,
  mangleLocal,
  mangleRawParam,
  mangleRecordStruct,
} from "../mangle.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;
type IrAwaitExpr = Extract<IrExpr, { kind: "awaitExpr" | "awaitUnionExpr" }>;

interface RustAsyncHandlers {
  readonly fallthrough: () => void;
  readonly returned: (value: string) => void;
  readonly thrown: (reason: string) => void;
}

type RustAsyncCompletion =
  | { readonly kind: "fallthrough" }
  | { readonly kind: "return"; readonly value: string }
  | { readonly kind: "throw"; readonly reason: string };

interface RustClosureShape {
  readonly index: number;
  readonly type: IrFuncType;
  readonly targets: IrFunction[];
}

interface RustClassMeta {
  readonly def: IrClassDef;
  base: RustClassMeta | null;
  readonly children: RustClassMeta[];
  root: RustClassMeta;
  pre: number;
  post: number;
  hierarchy: boolean;
  readonly slots: RustVtSlot[];
}

interface RustVtSlot {
  readonly method: string;
  readonly declarer: RustClassMeta;
  readonly fn: IrFunction;
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
  private readonly classes = new Map<string, IrClassDef>();
  private readonly classMeta = new Map<string, RustClassMeta>();
  private readonly globals = new Map<string, IrGlobal>();
  private readonly records = new Map<string, IrRecordShape>();
  private readonly unions = new Map<string, IrUnionDef>();
  private readonly closureShapes = new Map<string, RustClosureShape>();
  private readonly closureTargets = new Map<string, RustClosureShape>();
  private readonly promiseResolverTypes = new Map<string, IrType>();
  private readonly promiseRejectorTypes = new Map<string, IrType[]>();
  private readonly internedClosureTargets = new Set<string>();
  private indent = 0;
  private temporary = 0;
  private currentFunction: IrFunction | null = null;
  private currentAsyncResult: string | null = null;
  private currentAsyncLocals: Set<string> | null = null;
  private asyncProtectedReturnDepth = 0;
  private capturedReturnDepth = 0;
  private readonly loopTargets: { id: number; breakLabel: string; continueBlock: string | null }[] = [];
  private readonly completionLoopBoundaries: number[] = [];
  private nextLoopTargetId = 0;

  constructor(private readonly mod: IrModule) {
    for (const fn of mod.functions) this.functions.set(fn.name, fn);
    for (const cls of mod.classes ?? []) {
      if (!cls.runtime) {
        this.classes.set(cls.name, cls);
        this.classMeta.set(cls.name, {
          def: cls,
          base: null,
          children: [],
          root: undefined as unknown as RustClassMeta,
          pre: 0,
          post: 0,
          hierarchy: false,
          slots: [],
        });
      }
    }
    for (const global of mod.globals ?? []) this.globals.set(global.id, global);
    for (const record of mod.records ?? []) this.records.set(record.id, record);
    for (const union of mod.unions ?? []) this.unions.set(union.id, union);
    this.buildClassGraph();
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
    this.emitClassDefinitions();
    this.emitErrorValueDefinition();
    this.emitGlobals();
    for (const fn of this.mod.functions) {
      if (fn.captures !== undefined && !this.closureTargets.has(fn.name)) continue;
      // The frontend may intern this helper while probing process.env as a
      // receiver, even when every actual read becomes process.envGet. Its
      // indexed-record body is irrelevant unless a whole env value escapes.
      if (fn.name.startsWith("%env.snapshot.") && !this.isFunctionReferenced(fn.name)) continue;
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
    this.line("runtime::init();");
    this.line("let _sc_execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
    this.indent += 1;
    this.line(entry.async
      ? `let _sc_main_promise = ${mangleFunction(entry.name)}();`
      : `${mangleFunction(entry.name)}();`);
    this.line("runtime::run_event_loop();");
    this.line("let _sc_unhandled_rejection = runtime::had_unhandled_rejection();");
    if (entry.async) this.line("drop(_sc_main_promise);");
    this.line("_sc_unhandled_rejection");
    this.indent -= 1;
    this.line("}));");
    this.line("let (_sc_unhandled_rejection, _sc_uncaught) = match _sc_execution {");
    this.indent += 1;
    this.line("Ok(unhandled) => (unhandled, None),");
    this.line("Err(payload) => {");
    this.indent += 1;
    this.line("let caught = runtime::caught_from_panic(payload);");
    this.line(`let message = ${this.errorClassRoots().length === 0 ? "runtime::caught_to_string" : "sc_caught_to_string"}(&caught);`);
    this.line("drop(caught);");
    this.line("(false, Some(message))");
    this.indent -= 1;
    this.line("},");
    this.indent -= 1;
    this.line("};");
    for (const global of this.globals.values()) {
      if (this.isHeapRoot(global.type)) {
        this.line(`${mangleGlobal(global.id)}.with(|slot| *slot.borrow_mut() = None);`);
      }
    }
    for (const fnName of this.internedClosureTargets) {
      this.line(`${mangleFnClosure(fnName)}.with(|slot| *slot.borrow_mut() = None);`);
    }
    this.line("runtime::finish();");
    this.line("if let Some(reason) = _sc_uncaught { eprintln!(\"Uncaught {}\", reason); std::process::exit(1); }");
    this.line("if _sc_unhandled_rejection { std::process::exit(1); }");
    this.indent -= 1;
    this.line("}");
    return `${this.lines.join("\n")}\n`;
  }

  private checkModuleSurface(): void {
    for (const cls of this.classes.values()) {
      if (cls.base !== undefined && !this.classes.has(cls.base) &&
        (cls.base === "%DOMException" || !RUNTIME_ERROR_CLASSES.has(cls.base))) {
        this.unsupported(`inheritance from runtime-provided class '${cls.base}'`, cls.loc);
      }
    }
    if ((this.mod.ffiImports?.length ?? 0) > 0) this.unsupported("native FFI");
    if (this.mod.embedded !== undefined) this.unsupported("embedded dynamic modules");
    if (this.mod.lib !== undefined) this.unsupported("library mode");
  }

  private buildClassGraph(): void {
    for (const meta of this.classMeta.values()) {
      if (meta.def.base === undefined) continue;
      const base = this.classMeta.get(meta.def.base);
      if (base === undefined) continue;
      meta.base = base;
      base.children.push(meta);
    }
    let pre = 0;
    const number = (meta: RustClassMeta, root: RustClassMeta): void => {
      meta.root = root;
      meta.pre = pre++;
      for (const child of meta.children) number(child, root);
      meta.post = pre - 1;
    };
    for (const meta of this.classMeta.values()) {
      if (meta.base === null) number(meta, meta);
    }
    for (const meta of this.classMeta.values()) {
      meta.hierarchy = meta.base !== null || meta.children.length > 0;
    }
    const declares = (meta: RustClassMeta, method: string): boolean => meta.def.methods?.includes(method) ?? false;
    const declaredBelow = (meta: RustClassMeta, method: string): boolean =>
      meta.children.some((child) => declares(child, method) || declaredBelow(child, method));
    const collectSlots = (meta: RustClassMeta, root: RustClassMeta): void => {
      for (const method of meta.def.methods ?? []) {
        let inherited = false;
        for (let ancestor = meta.base; ancestor !== null; ancestor = ancestor.base) {
          inherited ||= declares(ancestor, method);
        }
        if (!inherited && declaredBelow(meta, method)) {
          let fn = this.functions.get(`%${meta.def.name}.${method}`);
          if (fn === undefined && meta.def.abstractMethods?.includes(method)) {
            const findImplementation = (candidate: RustClassMeta): IrFunction | undefined => {
              for (const child of candidate.children) {
                const implementation = child.def.methods?.includes(method) && !child.def.abstractMethods?.includes(method)
                  ? this.functions.get(`%${child.def.name}.${method}`)
                  : undefined;
                const found = implementation ?? findImplementation(child);
                if (found !== undefined) return found;
              }
              return undefined;
            };
            fn = findImplementation(meta);
            if (fn === undefined) continue;
          }
          if (fn === undefined) this.unsupported(`missing virtual method '${meta.def.name}.${method}'`, meta.def.loc);
          root.slots.push({ method, declarer: meta, fn });
        }
      }
      for (const child of meta.children) collectSlots(child, root);
    };
    for (const meta of this.classMeta.values()) {
      if (meta.base === null && meta.hierarchy) collectSlots(meta, meta);
    }
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
      if (node.kind === "newPromise") {
        const promiseType = node.type as IrType | undefined;
        const executor = node.executor as { type?: IrType } | undefined;
        const resolverType = executor?.type?.kind === "func" ? executor.type.params[0] : undefined;
        if (promiseType?.kind !== "promise" || executor?.type?.kind !== "func") {
          this.unsupported("malformed new Promise IR");
        }
        if (executor.type.params.length > 2) this.unsupported("malformed new Promise executor IR");
        if (resolverType === undefined) {
          if (executor.type.params.length !== 0) this.unsupported("malformed new Promise resolver IR");
        } else {
          if (resolverType.kind !== "func") this.unsupported("malformed new Promise resolver IR");
          const key = typeKey(resolverType);
          let shape = this.closureShapes.get(key);
          if (shape === undefined) {
            shape = { index: this.closureShapes.size, type: resolverType, targets: [] };
            this.closureShapes.set(key, shape);
          }
          const existing = this.promiseResolverTypes.get(key);
          if (existing !== undefined && typeKey(existing) !== typeKey(promiseType.inner)) {
            this.unsupported(`Promise resolver signature '${key}' with multiple value types`);
          }
          this.promiseResolverTypes.set(key, promiseType.inner);
        }
        const rejectorType = executor.type.params[1];
        if (rejectorType !== undefined) {
          if (rejectorType.kind !== "func") this.unsupported("malformed new Promise rejector IR");
          const key = typeKey(rejectorType);
          let shape = this.closureShapes.get(key);
          if (shape === undefined) {
            shape = { index: this.closureShapes.size, type: rejectorType, targets: [] };
            this.closureShapes.set(key, shape);
          }
          const promiseTypes = this.promiseRejectorTypes.get(key) ?? [];
          if (!promiseTypes.some((candidate) => typeKey(candidate) === typeKey(promiseType.inner))) {
            promiseTypes.push(promiseType.inner);
          }
          this.promiseRejectorTypes.set(key, promiseTypes);
        }
      }
      if (node.kind === "promiseWithResolvers") {
        const valueType = node.type as IrType | undefined;
        const record = valueType?.kind === "record" ? this.records.get(valueType.shapeId) : undefined;
        const promiseType = record?.fields.find((field) => field.name === "promise")?.type;
        const resolverType = record?.fields.find((field) => field.name === "resolve")?.type;
        const rejectorType = record?.fields.find((field) => field.name === "reject")?.type;
        if (promiseType?.kind !== "promise" || resolverType?.kind !== "func" || rejectorType?.kind !== "func") {
          this.unsupported("malformed Promise.withResolvers IR");
        }
        const resolverKey = typeKey(resolverType);
        let resolverShape = this.closureShapes.get(resolverKey);
        if (resolverShape === undefined) {
          resolverShape = { index: this.closureShapes.size, type: resolverType, targets: [] };
          this.closureShapes.set(resolverKey, resolverShape);
        }
        const existing = this.promiseResolverTypes.get(resolverKey);
        if (existing !== undefined && typeKey(existing) !== typeKey(promiseType.inner)) {
          this.unsupported(`Promise resolver signature '${resolverKey}' with multiple value types`);
        }
        this.promiseResolverTypes.set(resolverKey, promiseType.inner);

        const rejectorKey = typeKey(rejectorType);
        let rejectorShape = this.closureShapes.get(rejectorKey);
        if (rejectorShape === undefined) {
          rejectorShape = { index: this.closureShapes.size, type: rejectorType, targets: [] };
          this.closureShapes.set(rejectorKey, rejectorShape);
        }
        const promiseTypes = this.promiseRejectorTypes.get(rejectorKey) ?? [];
        if (!promiseTypes.some((candidate) => typeKey(candidate) === typeKey(promiseType.inner))) {
          promiseTypes.push(promiseType.inner);
        }
        this.promiseRejectorTypes.set(rejectorKey, promiseTypes);
      }
      for (const child of Object.values(node)) visit(child);
    };
    for (const fn of this.mod.functions) visit(fn.body);
  }

  private isFunctionReferenced(name: string): boolean {
    let found = false;
    const visit = (value: unknown): void => {
      if (found || value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const node = value as Record<string, unknown>;
      if ((node.kind === "call" && node.callee === name) || (node.kind === "closure" && node.fnName === name)) {
        found = true;
        return;
      }
      for (const child of Object.values(node)) visit(child);
    };
    for (const fn of this.mod.functions) {
      if (fn.name !== name) visit(fn.body);
    }
    return found;
  }

  private emitClosureDefinitions(): void {
    for (const shape of this.closureShapes.values()) {
      const name = this.closureName(shape);
      const resolverType = this.promiseResolverTypes.get(typeKey(shape.type));
      const rejectorTypes = this.promiseRejectorTypes.get(typeKey(shape.type)) ?? [];
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
      if (resolverType !== undefined) {
        this.line(`PromiseResolver { promise: Option<runtime::JsPromise<${this.rustType(resolverType)}>> },`);
      }
      rejectorTypes.forEach((promiseType, index) => {
        this.line(`PromiseRejector${index} { promise: Option<runtime::JsPromise<${this.rustType(promiseType)}>> },`);
      });
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${name} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      const capturing = shape.targets.filter((target) => (target.captures?.length ?? 0) > 0);
      if (capturing.length === 0 && resolverType === undefined && rejectorTypes.length === 0) {
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
        if (resolverType !== undefined) {
          this.line("Self::PromiseResolver { promise } => {");
          this.indent += 1;
          this.line("if let Some(edge) = promise { tracer.edge(edge); }");
          this.indent -= 1;
          this.line("},");
        }
        rejectorTypes.forEach((_, index) => {
          this.line(`Self::PromiseRejector${index} { promise } => {`);
          this.indent += 1;
          this.line("if let Some(edge) = promise { tracer.edge(edge); }");
          this.indent -= 1;
          this.line("},");
        });
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
      if (capturing.length > 0 || resolverType !== undefined || rejectorTypes.length > 0) {
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
        if (resolverType !== undefined) {
          this.line("Self::PromiseResolver { promise } => *promise = None,");
        }
        rejectorTypes.forEach((_, index) => {
          this.line(`Self::PromiseRejector${index} { promise } => *promise = None,`);
        });
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
      if (this.isRustJsonCompatible({ kind: "union", unionId: union.id })) {
        this.line(`impl runtime::JsonValue for ${name} {`);
        this.indent += 1;
        this.line("fn write_json(&self, writer: &mut runtime::JsonWriter) {");
        this.indent += 1;
        this.line("match self {");
        this.indent += 1;
        union.arms.forEach((arm, tag) => {
          const variant = `Self::${this.unionVariant(tag)}`;
          if (arm.kind === "nullT" || arm.kind === "undefinedT") {
            this.line(`${variant} => writer.write_null(),`);
          } else {
            this.line(`${variant}(value) => runtime::JsonValue::write_json(value, writer),`);
          }
        });
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        if (union.arms.some((arm) => arm.kind === "undefinedT")) {
          const undefinedVariants = union.arms.flatMap((arm, tag) =>
            arm.kind === "undefinedT" ? [`Self::${this.unionVariant(tag)}`] : []
          );
          this.line("fn is_json_undefined(&self) -> bool {");
          this.indent += 1;
          this.line(`matches!(self, ${undefinedVariants.join(" | ")})`);
          this.indent -= 1;
          this.line("}");
        }
        this.indent -= 1;
        this.line("}");
        this.line(`impl runtime::JsonDecode for ${name} {`);
        this.indent += 1;
        this.line("fn decode_json(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {");
        this.indent += 1;
        union.arms.forEach((arm, tag) => {
          const variant = `Self::${this.unionVariant(tag)}`;
          if (arm.kind === "nullT") {
            this.line(`if matches!(node, runtime::JsonNode::Null) { return Ok(${variant}); }`);
          } else if (arm.kind !== "undefinedT") {
            const type = this.rustType(arm);
            this.line(`if let Ok(value) = <${type} as runtime::JsonDecode>::decode_json(node, path) { return Ok(${variant}(value)); }`);
          }
        });
        this.line(`Err(runtime::json_type_error(path, "${this.rustString(typeKey({ kind: "union", unionId: union.id }))}", node))`);
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
      }
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
        case "classval":
          comparison = "left == right";
          break;
        case "string":
          comparison = "left.as_ref() == right.as_ref()";
          break;
        case "array":
        case "map":
        case "set":
        case "stats":
        case "spawnRes":
        case "record":
        case "func":
        case "promise":
          comparison = "left.ptr_eq(right)";
          break;
        case "object":
          comparison = RUNTIME_ERROR_CLASSES.has(arm.className) ? "std::ptr::eq(left, right)" : "left.ptr_eq(right)";
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
      // Some intrinsic-only surfaces, notably process.env, carry an indexed
      // record type through the IR even though every operation lowers to a
      // dedicated libCall. Do not reject those unused nominal shapes here;
      // rustType still fences an indexed record if a value actually escapes.
      if (shape.indexValue !== undefined) continue;
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
      if (this.isRustJsonCompatible({ kind: "record", shapeId: shape.id })) {
        this.line(`impl runtime::JsonObject for ${struct} {`);
        this.indent += 1;
        this.line("fn write_json_object(&self, writer: &mut runtime::JsonWriter) {");
        this.indent += 1;
        this.line(shape.tuple ? "writer.begin_array();" : "writer.begin_object();");
        this.line("let mut first = true;");
        const byName = new Map(shape.fields.map((field) => [field.name, field]));
        const fields = shape.tuple
          ? [...shape.fields].sort((left, right) => Number(left.name) - Number(right.name))
          : (shape.declaredOrder ?? shape.fields.map((field) => field.name))
            .map((name) => byName.get(name))
            .filter((field) => field !== undefined);
        for (const field of fields) {
          const stored = `self.${mangleField(field.name)}`;
          const value = this.isEdgeValue(field.type)
            ? `${stored}.as_ref().expect("scriptc: cleared live JSON record field")`
            : `&${stored}`;
          this.line(shape.tuple
            ? `writer.element(&mut first, ${value});`
            : `writer.property(&mut first, "${this.rustString(field.name)}", ${value});`);
        }
        this.line(shape.tuple ? "writer.end_array();" : "writer.end_object();");
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        this.line(`impl runtime::JsonObjectDecode for ${struct} {`);
        this.indent += 1;
        this.line("fn decode_json_object(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {");
        this.indent += 1;
        this.line(shape.tuple
          ? "let values = runtime::json_expect_array(node, path)?;"
          : "let values = runtime::json_expect_object(node, path)?;");
        this.line(`Ok(${struct} {`);
        this.indent += 1;
        for (const field of shape.fields) {
          const type = this.rustType(field.type);
          let decoded: string;
          if (shape.tuple) {
            const index = Number(field.name);
            const node = `values.get(${index}).ok_or_else(|| format!("expected index ${index} at {path}"))?`;
            decoded = `<${type} as runtime::JsonDecode>::decode_json(${node}, &runtime::json_index_path(path, ${index}))?`;
          } else {
            const property = `"${this.rustString(field.name)}"`;
            const path = `runtime::json_property_path(path, ${property})`;
            const optionalTag = field.type.kind === "union"
              ? this.union(field.type.unionId).arms.findIndex((arm) => arm.kind === "undefinedT")
              : -1;
            if (optionalTag >= 0 && field.type.kind === "union") {
              decoded = `match runtime::json_object_field(values, ${property}) { Some(value) => <${type} as runtime::JsonDecode>::decode_json(value, &${path})?, None => ${type}::${this.unionVariant(optionalTag)}, }`;
            } else {
              decoded = `<${type} as runtime::JsonDecode>::decode_json(runtime::json_required_field(values, ${property}, path)?, &${path})?`;
            }
          }
          this.line(`${mangleField(field.name)}: ${this.isEdgeValue(field.type) ? `Some(${decoded})` : decoded},`);
        }
        this.indent -= 1;
        this.line("})");
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
      }
      this.line("");
    }
  }

  private emitClassDefinitions(): void {
    for (const meta of this.classMeta.values()) {
      if (meta.hierarchy && meta !== meta.root) continue;
      const cls = meta.def;
      const struct = mangleClassStruct(cls.name);
      const fields = meta.hierarchy ? this.hierarchyFields(meta) : cls.fields.map((field) => ({ owner: meta, field }));
      this.line(`struct ${struct} {`);
      this.indent += 1;
      if (meta.hierarchy) this.line("sc_class_pre: usize,");
      for (const { owner, field } of fields) {
        const fieldType = this.isEdgeValue(field.type)
          ? `Option<${this.rustType(field.type, cls.loc)}>`
          : this.rustType(field.type, cls.loc);
        this.line(`${this.classFieldStorageName(owner, field.name)}: ${fieldType},`);
      }
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${struct} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      for (const { owner, field } of fields) {
        if (!this.isEdgeValue(field.type)) continue;
        const name = this.classFieldStorageName(owner, field.name);
        this.line(this.isTracedHandle(field.type)
          ? `if let Some(edge) = &self.${name} { tracer.edge(edge); }`
          : `if let Some(edge) = &self.${name} { runtime::Trace::trace(edge, tracer); }`);
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ClearEdges for ${struct} {`);
      this.indent += 1;
      this.line("fn clear_edges(&mut self) {");
      this.indent += 1;
      for (const { owner, field } of fields) {
        if (this.isEdgeValue(field.type)) this.line(`self.${this.classFieldStorageName(owner, field.name)} = None;`);
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line("");
    }
  }

  private emitErrorValueDefinition(): void {
    const roots = this.errorClassRoots();
    if (roots.length === 0) return;
    const name = this.errorValueName();
    this.line("#[derive(Clone)]");
    this.line(`enum ${name} {`);
    this.indent += 1;
    this.line("Builtin(runtime::JsError),");
    for (const root of roots) {
      this.line(`${this.errorValueVariant(root)}(runtime::Gc<${this.classStructName(root.def.name)}>),`);
    }
    this.indent -= 1;
    this.line("}");
    this.line(`impl runtime::Trace for ${name} {`);
    this.indent += 1;
    this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
    this.indent += 1;
    this.line("match self {");
    this.indent += 1;
    this.line("Self::Builtin(_) => {},");
    for (const root of roots) this.line(`Self::${this.errorValueVariant(root)}(value) => tracer.edge(value),`);
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("}");
    this.line(`impl runtime::HeapValue for ${name} {`);
    this.indent += 1;
    this.line("fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.indent -= 1;
    this.line("}");
    this.line(`impl runtime::ArrayElement for ${name} {`);
    this.indent += 1;
    this.line("fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.indent -= 1;
    this.line("}");
    this.line(`fn sc_error_is_class(value: &${name}, target: &str) -> bool {`);
    this.indent += 1;
    this.line("match value {");
    this.indent += 1;
    this.line(`${name}::Builtin(error) => runtime::error_is_class(error, target),`);
    for (const root of roots) {
      const classes = this.runtimeErrorClassNames(root.def.name);
      this.line(`${name}::${this.errorValueVariant(root)}(_) => matches!(target, ${classes.map((value) => `"${this.rustString(value)}"`).join(" | ")}),`);
    }
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("}");
    this.emitErrorValueStringHelper("name");
    this.emitErrorValueStringHelper("message");
    this.line(`fn sc_error_to_string(value: &${name}) -> runtime::JsString {`);
    this.indent += 1;
    this.line("match value {");
    this.indent += 1;
    this.line(`${name}::Builtin(error) => runtime::error_to_string(error),`);
    for (const root of roots) {
      const nameField = this.classFieldName(root.def.name, "name");
      const messageField = this.classFieldName(root.def.name, "message");
      this.line(`${name}::${this.errorValueVariant(root)}(value) => value.with(|object| runtime::error_to_string_parts(object.${nameField}.as_ref(), object.${messageField}.as_ref())),`);
    }
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("}");
    this.line(`fn sc_caught_error_value(caught: &runtime::Caught) -> ${name} {`);
    this.indent += 1;
    this.line(`if runtime::caught_is::<${name}>(caught) { return runtime::caught_narrow::<${name}>(caught); }`);
    this.line(`if runtime::caught_is::<runtime::JsError>(caught) { return ${name}::Builtin(runtime::caught_narrow::<runtime::JsError>(caught)); }`);
    for (const root of roots) {
      const typeName = `runtime::Gc<${this.classStructName(root.def.name)}>`;
      this.line(`if runtime::caught_is::<${typeName}>(caught) { return ${name}::${this.errorValueVariant(root)}(runtime::caught_narrow::<${typeName}>(caught)); }`);
    }
    this.line("unreachable!(\"scriptc invariant: caught value is not an Error\")");
    this.indent -= 1;
    this.line("}");
    this.line(`fn sc_caught_is_error_class(caught: &runtime::Caught, target: &str) -> bool {`);
    this.indent += 1;
    this.line(`if runtime::caught_is::<${name}>(caught) { return sc_error_is_class(&runtime::caught_narrow::<${name}>(caught), target); }`);
    this.line("if runtime::caught_is::<runtime::JsError>(caught) { return runtime::caught_is_error_class(caught, target); }");
    for (const root of roots) {
      const typeName = `runtime::Gc<${this.classStructName(root.def.name)}>`;
      const classes = this.runtimeErrorClassNames(root.def.name);
      this.line(`if runtime::caught_is::<${typeName}>(caught) { return matches!(target, ${classes.map((value) => `"${this.rustString(value)}"`).join(" | ")}); }`);
    }
    this.line("false");
    this.indent -= 1;
    this.line("}");
    this.line("fn sc_caught_to_string(caught: &runtime::Caught) -> runtime::JsString {");
    this.indent += 1;
    this.line("if sc_caught_is_error_class(caught, \"Error\") { return sc_error_to_string(&sc_caught_error_value(caught)); }");
    this.line("runtime::caught_to_string(caught)");
    this.indent -= 1;
    this.line("}");
    this.line("");
  }

  private emitErrorValueStringHelper(field: "name" | "message"): void {
    const roots = this.errorClassRoots();
    const name = this.errorValueName();
    this.line(`fn sc_error_${field}(value: &${name}) -> runtime::JsString {`);
    this.indent += 1;
    this.line("match value {");
    this.indent += 1;
    this.line(`${name}::Builtin(error) => runtime::error_${field}(error),`);
    for (const root of roots) {
      const fieldName = this.classFieldName(root.def.name, field);
      this.line(`${name}::${this.errorValueVariant(root)}(value) => value.with(|object| object.${fieldName}.clone()),`);
    }
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("}");
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
        case "classval":
          this.line(`static ${name}: Cell<usize> = const { Cell::new(0) };`);
          break;
        case "string":
          this.line(`static ${name}: RefCell<runtime::JsString> = RefCell::new(runtime::empty_string());`);
          break;
        case "array":
        case "bytes":
        case "stats":
        case "spawnRes":
        case "map":
        case "set":
        case "record":
        case "object":
        case "union":
        case "func":
        case "promise":
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
      const boxed = local.boxed || fn.async === true;
      const name = boxed ? mangleRawParam(param.localId) : mangleLocal(param.localId);
      return `${local.mutable && !boxed ? "mut " : ""}${name}: ${this.rustType(param.type, fn.loc)}`;
    }));
    const returnType = this.rustType(fn.returnType, fn.loc);
    const emittedReturnType = fn.async ? `runtime::JsPromise<${returnType}>` : returnType;
    this.line(`fn ${mangleFunction(fn.name)}(${params.join(", ")})${emittedReturnType === "()" ? "" : ` -> ${emittedReturnType}`} {`);
    this.indent += 1;
    this.currentFunction = fn;
    for (const param of fn.params) {
      const local = fn.locals.find((candidate) => candidate.id === param.localId);
      if (local !== undefined && (local.boxed || fn.async === true)) {
        this.line(`let ${mangleLocal(param.localId)} = runtime::cell_new(${mangleRawParam(param.localId)});`);
      }
    }
    if (fn.async) {
      const result = `sc_async_result_${this.temporary++}`;
      const bodyResult = `sc_async_result_${this.temporary++}`;
      const guard = `sc_async_guard_${this.temporary++}`;
      this.line(`let ${result} = runtime::promise_new();`);
      this.line(`let ${bodyResult} = ${result}.clone();`);
      this.line(`let ${guard} = ${result}.clone();`);
      this.line(`runtime::promise_run_segment(&${guard}, move || {`);
      this.indent += 1;
      this.line(`let ${bodyResult} = ${bodyResult};`);
      this.currentAsyncResult = bodyResult;
      this.currentAsyncLocals = new Set([
        ...fn.params.map((param) => param.localId),
        ...(fn.captures ?? []).map((capture) => capture.localId),
      ]);
      this.emitAsyncStatements(fn.body);
      this.currentAsyncResult = null;
      this.currentAsyncLocals = null;
      this.indent -= 1;
      this.line("});");
      this.line(result);
    } else {
      this.emitStatements(fn.body);
      if (fn.returnType.kind !== "void") {
        this.line(`unreachable!("scriptc invariant: function '${this.rustString(fn.name)}' fell through")`);
      }
    }
    this.currentFunction = null;
    this.indent -= 1;
    this.line("}");
  }

  private containsAsyncSuspension(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => this.containsAsyncSuspension(item));
    const node = value as { kind?: unknown; fn?: unknown };
    if (node.kind === "awaitExpr" || node.kind === "awaitUnionExpr") return true;
    if (node.kind === "libCall" && node.fn === "async.hop") return true;
    return Object.values(value).some((item) => this.containsAsyncSuspension(item));
  }

  private awaitExpression(expr: IrExpr | null): IrAwaitExpr | null {
    return expr?.kind === "awaitExpr" || expr?.kind === "awaitUnionExpr" ? expr : null;
  }

  private asyncHopSequence(expr: IrExpr | null): {
    prelude: readonly IrStmt[];
    result: IrExpr;
  } | null {
    if (expr?.kind !== "seqExpr") return null;
    const hop = expr.stmts.findIndex((candidate) =>
      candidate.kind === "exprStmt" && candidate.expr.kind === "libCall" && candidate.expr.fn === "async.hop"
    );
    if (hop < 0) return null;
    if (hop !== expr.stmts.length - 1 || expr.result.kind !== "varRef" ||
      this.containsAsyncSuspension(expr.stmts.slice(0, hop))) {
      this.unsupported("non-canonical await-value hop", expr.loc);
    }
    return { prelude: expr.stmts.slice(0, hop), result: expr.result };
  }

  private awaitedValue(expr: IrExpr | null): { awaited: IrAwaitExpr; wrap: (value: string) => string } | null {
    const awaited = this.awaitExpression(expr);
    if (awaited !== null) return { awaited, wrap: (value) => value };
    if (expr?.kind !== "unionWrap") return null;
    const inner = this.awaitedValue(expr.value);
    if (inner === null) return null;
    const union = this.union(expr.unionId, expr.loc);
    const arm = union.arms[expr.tag];
    if (arm === undefined || this.isUnit(arm)) {
      this.unsupported(`awaited union wrapper '${expr.unionId}:${expr.tag}'`, expr.loc);
    }
    const variant = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}`;
    return { awaited: inner.awaited, wrap: (value) => `${variant}(${inner.wrap(value)})` };
  }

  private emitAwaitDependency(expr: IrAwaitExpr): string {
    if (expr.kind === "awaitExpr") return this.emitExpr(expr.value);
    if (expr.value.type.kind !== "union") this.unsupported("await union with a non-union operand", expr.loc);
    const source = this.union(expr.value.type.unionId, expr.loc);
    const promiseArm = source.arms[expr.promiseTag];
    if (promiseArm?.kind !== "promise") this.unsupported("await union without a Promise arm", expr.loc);
    const sourceName = this.unionName(source.id);
    const value = `sc_async_await_union_${this.temporary++}`;
    if (expr.type.kind === "void") {
      const arms = source.arms.map((arm, tag) => {
        const variant = `${sourceName}::${this.unionVariant(tag)}`;
        if (tag === expr.promiseTag) return `${variant}(promise) => promise`;
        if (this.isUnit(arm)) return `${variant} => runtime::promise_resolved(())`;
        this.unsupported(`await union arm '${arm.kind}'`, expr.loc);
      });
      return `{ let ${value} = ${this.emitExpr(expr.value)}; match ${value} { ${arms.join(", ")}, } }`;
    }
    if (expr.type.kind !== "union") this.unsupported("await union with a non-union result", expr.loc);
    const result = this.union(expr.type.unionId, expr.loc);
    const resultName = this.unionName(result.id);
    const resultTag = (arm: IrType): number => {
      const tag = result.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
      if (tag < 0) this.unsupported(`await union result missing arm '${arm.kind}'`, expr.loc);
      return tag;
    };
    const arms = source.arms.map((arm, tag) => {
      const variant = `${sourceName}::${this.unionVariant(tag)}`;
      const target = `${resultName}::${this.unionVariant(resultTag(tag === expr.promiseTag ? promiseArm.inner : arm))}`;
      if (tag === expr.promiseTag) return `${variant}(promise) => runtime::promise_map(&promise, |value| ${target}(value))`;
      if (this.isUnit(arm)) return `${variant} => runtime::promise_resolved(${target})`;
      this.unsupported(`await union arm '${arm.kind}'`, expr.loc);
    });
    return `{ let ${value} = ${this.emitExpr(expr.value)}; match ${value} { ${arms.join(", ")}, } }`;
  }

  private emitAsyncStatements(statements: readonly IrStmt[], onComplete: (() => void) | null = null): void {
    const result = this.currentAsyncResult;
    const fn = this.currentFunction;
    if (result === null || fn?.async !== true) this.unsupported("async continuation outside an async function", fn?.loc);

    for (let index = 0; index < statements.length; index += 1) {
      const stmt = statements[index];
      if (stmt === undefined) break;
      if (stmt.kind === "while" && this.containsAsyncSuspension(stmt.body)) {
        this.emitAsyncWhile(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "forOf" && this.containsAsyncSuspension(stmt.body)) {
        this.emitAsyncForOf(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "for" && this.containsAsyncSuspension(stmt.body)) {
        this.emitAsyncFor(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "block" && this.containsAsyncSuspension(stmt.body)) {
        const outerLocals = new Set(this.currentAsyncLocals ?? []);
        const resume = this.emitAsyncResumeHelper(
          statements.slice(index + 1),
          onComplete,
          outerLocals,
          stmt.loc,
          "block_continue",
        );
        this.withAsyncLocals(new Set(outerLocals), () => this.emitAsyncStatements(stmt.body, resume));
        return;
      }
      if (stmt.kind === "if" && this.containsAsyncSuspension(stmt)) {
        this.emitAsyncIf(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "tryCatch" && this.containsAsyncSuspension(stmt)) {
        this.emitAsyncTryCatch(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      const nested =
        stmt.kind === "assign" ? stmt.value
        : stmt.kind === "varDecl" ? stmt.init
        : stmt.kind === "exprStmt" ? stmt.expr
        : stmt.kind === "return" ? stmt.value
        : null;
      const hop = this.asyncHopSequence(nested);
      if (hop !== null) {
        for (const prelude of hop.prelude) {
          this.emitStatement(prelude);
          if (prelude.kind === "varDecl") this.currentAsyncLocals?.add(prelude.localId);
        }
        this.emitAsyncContinuation(
          "runtime::promise_resolved(())",
          (rawValue) => {
            this.line(`let _ = ${rawValue};`);
            const value = this.emitExpr(hop.result);
            if (stmt.kind === "assign") {
              this.emitAssignment(stmt.localId, value, stmt.loc);
            } else if (stmt.kind === "varDecl") {
              const local = this.local(stmt.localId, stmt.loc);
              this.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = runtime::cell_new(${value});`);
              this.currentAsyncLocals?.add(local.id);
            } else if (stmt.kind === "exprStmt") {
              this.line(`let _ = ${value};`);
            } else {
              this.line(`let _ = runtime::promise_fulfill(&${result}, ${value});`);
              this.line("return;");
            }
          },
          stmt.kind === "return" ? null : statements.slice(index + 1),
          onComplete,
        );
        return;
      }
      if (stmt.kind === "exprStmt" && stmt.expr.kind === "intrinsic" &&
        (stmt.expr.name === "console.log" || stmt.expr.name === "console.error") &&
        stmt.expr.args.some((arg) => this.containsAsyncSuspension(arg))) {
        this.emitAsyncConsole(stmt.expr, statements.slice(index + 1), 0, [], onComplete);
        return;
      }
      const awaited = this.awaitedValue(
        stmt.kind === "assign" ? stmt.value
        : stmt.kind === "varDecl" ? stmt.init
        : stmt.kind === "exprStmt" ? stmt.expr
        : stmt.kind === "return" ? stmt.value
        : null,
      );
      if (awaited === null) {
        if ((nested?.kind === "bin" || nested?.kind === "toString" || nested?.kind === "strConcat" ||
          nested?.kind === "recordLit" || nested?.kind === "arrayGet" || nested?.kind === "arrIntrinsic" ||
          nested?.kind === "mapIntrinsic") &&
          this.containsAsyncSuspension(nested)) {
          this.emitAsyncValue(nested, (value) => {
            if (stmt.kind === "assign") {
              this.emitAssignment(stmt.localId, value, stmt.loc);
              this.emitAsyncStatements(statements.slice(index + 1), onComplete);
            } else if (stmt.kind === "varDecl") {
              const local = this.local(stmt.localId, stmt.loc);
              this.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = runtime::cell_new(${value});`);
              this.currentAsyncLocals?.add(local.id);
              this.emitAsyncStatements(statements.slice(index + 1), onComplete);
            } else if (stmt.kind === "exprStmt") {
              this.line(`let _ = ${value};`);
              this.emitAsyncStatements(statements.slice(index + 1), onComplete);
            } else {
              this.line(`let _ = runtime::promise_fulfill(&${result}, ${value});`);
              this.line("return;");
            }
          });
          return;
        }
        if (this.containsAsyncSuspension(stmt)) {
          this.unsupported("nested async suspension in the Rust state-machine subset", stmt.loc);
        }
        this.emitStatement(stmt);
        if (stmt.kind === "varDecl") this.currentAsyncLocals?.add(stmt.localId);
        continue;
      }

      this.emitAsyncContinuation(
        this.emitAwaitDependency(awaited.awaited),
        (rawValue) => {
          const value = awaited.wrap(rawValue);
          if (stmt.kind === "assign") {
            this.emitAssignment(stmt.localId, value, stmt.loc);
          } else if (stmt.kind === "varDecl") {
            const local = this.local(stmt.localId, stmt.loc);
            this.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = runtime::cell_new(${value});`);
            this.currentAsyncLocals?.add(local.id);
          } else if (stmt.kind === "exprStmt") {
            this.line(`let _ = ${value};`);
          } else {
            this.line(`let _ = runtime::promise_fulfill(&${result}, ${value});`);
            this.line("return;");
          }
        },
        stmt.kind === "return" ? null : statements.slice(index + 1),
        onComplete,
      );
      return;
    }

    if (onComplete !== null) {
      onComplete();
    } else if (fn.returnType.kind === "void") {
      this.line(`let _ = runtime::promise_fulfill(&${result}, ());`);
    } else {
      this.line(`unreachable!("scriptc invariant: async function '${this.rustString(fn.name)}' fell through");`);
    }
  }

  private emitAsyncTryCatch(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const outerLocals = new Set(this.currentAsyncLocals ?? []);
    const resume = this.emitAsyncResumeHelper(remaining, onComplete, outerLocals, stmt.loc, "try_continue");
    this.emitAsyncProtectedSequence(stmt.tryBody, outerLocals, {
      fallthrough: () => this.emitAsyncFinally(stmt, [], outerLocals, { kind: "fallthrough" }, resume),
      returned: (value) => this.emitAsyncFinally(stmt, [], outerLocals, { kind: "return", value }, resume),
      thrown: (reason) => this.emitAsyncCatch(stmt, [], outerLocals, reason, resume),
    }, stmt.loc);
  }

  private emitAsyncIf(
    stmt: Extract<IrStmt, { kind: "if" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    if (this.containsAsyncSuspension(stmt.cond)) {
      this.unsupported("async suspension in an if condition", stmt.loc);
    }
    const outerLocals = new Set(this.currentAsyncLocals ?? []);
    const resume = this.emitAsyncResumeHelper(remaining, onComplete, outerLocals, stmt.loc, "if_continue");
    this.line(`if ${this.emitExpr(stmt.cond)} {`);
    this.indent += 1;
    this.withAsyncLocals(new Set(outerLocals), () => this.emitAsyncStatements(stmt.then, resume));
    this.indent -= 1;
    this.line("} else {");
    this.indent += 1;
    const elseBody = stmt.else_;
    if (elseBody === null) {
      resume();
    } else {
      this.withAsyncLocals(new Set(outerLocals), () => this.emitAsyncStatements(elseBody, resume));
    }
    this.indent -= 1;
    this.line("}");
  }

  private emitAsyncFor(
    stmt: Extract<IrStmt, { kind: "for" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const result = this.currentAsyncResult;
    const fn = this.currentFunction;
    if (result === null || fn?.async !== true) this.unsupported("async for outside an async function", stmt.loc);
    if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled async for", stmt.loc);
    if (this.containsAsyncSuspension(stmt.init) || this.containsAsyncSuspension(stmt.cond) ||
      this.containsAsyncSuspension(stmt.update)) {
      this.unsupported("async suspension in for init, condition, or update", stmt.loc);
    }
    if (this.containsLoopControl(stmt.body)) {
      this.unsupported("break or continue in a suspended async for", stmt.loc);
    }
    if (stmt.init !== null) {
      this.emitStatement(stmt.init);
      if (stmt.init.kind === "varDecl") this.currentAsyncLocals?.add(stmt.init.localId);
    }
    const loopLocals = new Set(this.currentAsyncLocals ?? []);
    const helper = `sc_async_loop_${this.temporary++}`;
    const locals = [...loopLocals].map((localId) => this.local(localId, stmt.loc));
    const resultType = this.rustType(fn.returnType, stmt.loc);
    const params = [
      `${result}: runtime::JsPromise<${resultType}>`,
      ...locals.map((local) =>
        `${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}>`
      ),
    ];
    const call = () => `${helper}(${[
      `${result}.clone()`,
      ...locals.map((local) => `${mangleLocal(local.id)}.clone()`),
    ].join(", ")});`;
    this.line(`fn ${helper}(${params.join(", ")}) {`);
    this.indent += 1;
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.line(`if ${stmt.cond === null ? "true" : this.emitExpr(stmt.cond)} {`);
      this.indent += 1;
      this.emitAsyncStatements(stmt.body, () => {
        this.withAsyncLocals(new Set(loopLocals), () => {
          if (stmt.update !== null) this.emitStatement(stmt.update);
          this.line(call());
          this.line("return;");
        });
      });
      this.indent -= 1;
      this.line("} else {");
      this.indent += 1;
      this.emitAsyncStatements(remaining, onComplete);
      this.indent -= 1;
      this.line("}");
    });
    this.indent -= 1;
    this.line("}");
    this.line(call());
    this.line("return;");
  }

  private emitAsyncWhile(
    stmt: Extract<IrStmt, { kind: "while" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const result = this.currentAsyncResult;
    const fn = this.currentFunction;
    if (result === null || fn?.async !== true) this.unsupported("async while outside an async function", stmt.loc);
    if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled async while", stmt.loc);
    if (this.containsAsyncSuspension(stmt.cond)) this.unsupported("async suspension in a while condition", stmt.loc);
    if (this.containsLoopControl(stmt.body)) {
      this.unsupported("break or continue in a suspended async while", stmt.loc);
    }

    const loopLocals = new Set(this.currentAsyncLocals ?? []);
    const locals = [...loopLocals].map((localId) => this.local(localId, stmt.loc));
    const helper = `sc_async_while_${this.temporary++}`;
    const params = [
      `${result}: runtime::JsPromise<${this.rustType(fn.returnType, stmt.loc)}>`,
      ...locals.map((local) =>
        `${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}>`
      ),
    ];
    const call = `${helper}(${[
      `${result}.clone()`,
      ...locals.map((local) => `${mangleLocal(local.id)}.clone()`),
    ].join(", ")});`;

    this.line(`fn ${helper}(${params.join(", ")}) {`);
    this.indent += 1;
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.line(`if ${this.emitExpr(stmt.cond)} {`);
      this.indent += 1;
      this.emitAsyncStatements(stmt.body, () => this.withAsyncLocals(new Set(loopLocals), () => {
        this.line(call);
        this.line("return;");
      }));
      this.indent -= 1;
      this.line("} else {");
      this.indent += 1;
      this.emitAsyncStatements(remaining, onComplete);
      this.indent -= 1;
      this.line("}");
    });
    this.indent -= 1;
    this.line("}");
    this.line(call);
    this.line("return;");
  }

  private emitAsyncForOf(
    stmt: Extract<IrStmt, { kind: "forOf" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const result = this.currentAsyncResult;
    const fn = this.currentFunction;
    if (result === null || fn?.async !== true) this.unsupported("async for-of outside an async function", stmt.loc);
    if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled async for-of", stmt.loc);
    if (stmt.iterable.type.kind !== "array") this.unsupported("async for-of over a non-array", stmt.loc);
    if (this.containsAsyncSuspension(stmt.iterable)) {
      this.unsupported("async suspension in a for-of iterable", stmt.loc);
    }
    if (this.containsLoopControl(stmt.body)) {
      this.unsupported("break or continue in a suspended async for-of", stmt.loc);
    }

    const loopLocals = new Set(this.currentAsyncLocals ?? []);
    const locals = [...loopLocals].map((localId) => this.local(localId, stmt.loc));
    const local = this.local(stmt.localId, stmt.loc);
    const helper = `sc_async_for_of_${this.temporary++}`;
    const array = `sc_async_for_of_array_${this.temporary++}`;
    const index = `sc_async_for_of_index_${this.temporary++}`;
    const params = [
      `${result}: runtime::JsPromise<${this.rustType(fn.returnType, stmt.loc)}>`,
      `${array}: ${this.rustType(stmt.iterable.type, stmt.loc)}`,
      `${index}: f64`,
      ...locals.map((candidate) =>
        `${mangleLocal(candidate.id)}: runtime::JsCell<${this.rustType(candidate.type, stmt.loc)}>`
      ),
    ];
    const call = (nextIndex: string) => `${helper}(${[
      `${result}.clone()`,
      `${array}.clone()`,
      nextIndex,
      ...locals.map((candidate) => `${mangleLocal(candidate.id)}.clone()`),
    ].join(", ")});`;

    this.line(`let ${array} = ${this.emitExpr(stmt.iterable)};`);
    this.line(`fn ${helper}(${params.join(", ")}) {`);
    this.indent += 1;
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.line(`if ${index} < runtime::array_len(&${array}) {`);
      this.indent += 1;
      this.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`);
      const iterationLocals = new Set(loopLocals);
      iterationLocals.add(local.id);
      this.withAsyncLocals(iterationLocals, () => {
        this.emitAsyncStatements(stmt.body, () => this.withAsyncLocals(new Set(loopLocals), () => {
          this.line(call(`${index} + 1.0_f64`));
          this.line("return;");
        }));
      });
      this.indent -= 1;
      this.line("} else {");
      this.indent += 1;
      this.withAsyncLocals(new Set(loopLocals), () => this.emitAsyncStatements(remaining, onComplete));
      this.indent -= 1;
      this.line("}");
    });
    this.indent -= 1;
    this.line("}");
    this.line(call("0.0_f64"));
    this.line("return;");
  }

  private containsLoopControl(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => this.containsLoopControl(item));
    const node = value as { kind?: unknown };
    if (node.kind === "break" || node.kind === "continue") return true;
    return Object.values(value).some((item) => this.containsLoopControl(item));
  }

  private emitAsyncProtectedSequence(
    statements: readonly IrStmt[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    loc: SrcLoc,
  ): void {
    const result = this.currentAsyncResult;
    const fn = this.currentFunction;
    if (result === null || fn?.async !== true) this.unsupported("async protected segment without a result promise", loc);
    const segment = `sc_async_segment_${this.temporary++}`;
    this.line(`let ${segment} = runtime::promise_try_segment::<${this.rustType(fn.returnType, loc)}, _>(|| {`);
    this.indent += 1;
    let terminal: "await" | "return" | null = null;
    this.withAsyncLocals(new Set(this.currentAsyncLocals ?? []), () => {
      for (let index = 0; index < statements.length; index += 1) {
        const current = statements[index];
        if (current === undefined) break;
        if (current.kind === "forOf" && this.containsAsyncSuspension(current.body)) {
          this.emitAsyncProtectedForOf(
            current,
            statements.slice(index + 1),
            exitLocals,
            handlers,
            loc,
          );
          this.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        if (current.kind === "exprStmt" && current.expr.kind === "intrinsic" &&
          (current.expr.name === "console.log" || current.expr.name === "console.error") &&
          current.expr.args.some((arg) => this.containsAsyncSuspension(arg))) {
          this.emitAsyncProtectedConsole(
            current.expr,
            statements.slice(index + 1),
            exitLocals,
            handlers,
            loc,
          );
          this.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        const awaited = this.awaitedValue(
          current.kind === "assign" ? current.value
          : current.kind === "varDecl" ? current.init
          : current.kind === "exprStmt" ? current.expr
          : current.kind === "return" ? current.value
          : null,
        );
        if (awaited !== null) {
          this.emitAsyncProtectedContinuation(
            this.emitAwaitDependency(awaited.awaited),
            exitLocals,
            handlers,
            (value) => {
              const completedValue = awaited.wrap(value);
              if (current.kind === "assign") {
                this.emitAssignment(current.localId, completedValue, current.loc);
                this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
              } else if (current.kind === "varDecl") {
                const local = this.local(current.localId, current.loc);
                this.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, current.loc)}> = runtime::cell_new(${completedValue});`);
                this.currentAsyncLocals?.add(local.id);
                this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
              } else if (current.kind === "exprStmt") {
                this.line(`let _ = ${completedValue};`);
                this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
              } else {
                this.withAsyncLocals(new Set(exitLocals), () => handlers.returned(completedValue));
              }
            },
          );
          this.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        if (this.containsAsyncSuspension(current)) {
          this.unsupported("nested async suspension inside a Rust protected segment", current.loc);
        }
        if (current.kind === "return") {
          const value = current.value === null ? "()" : this.emitExpr(current.value);
          this.line(`return runtime::AsyncCompletion::Return(${value});`);
          terminal = "return";
          break;
        }
        this.asyncProtectedReturnDepth += 1;
        try {
          this.emitStatement(current);
        } finally {
          this.asyncProtectedReturnDepth -= 1;
        }
        if (current.kind === "varDecl") this.currentAsyncLocals?.add(current.localId);
      }
    });
    if (terminal === null) this.line("runtime::AsyncCompletion::Fallthrough");
    this.indent -= 1;
    this.line("});");
    this.line(`match ${segment} {`);
    this.indent += 1;
    if (terminal === null) {
      this.line("Ok(runtime::AsyncCompletion::Fallthrough) => {");
      this.indent += 1;
      this.withAsyncLocals(new Set(exitLocals), handlers.fallthrough);
      this.indent -= 1;
      this.line("},");
      this.line("Ok(runtime::AsyncCompletion::Return(value)) => {");
      this.indent += 1;
      this.withAsyncLocals(new Set(exitLocals), () => handlers.returned("value"));
      this.indent -= 1;
      this.line("},");
      this.line("Ok(runtime::AsyncCompletion::Suspended) => unreachable!(\"scriptc invariant: invalid async fallthrough completion\"),");
    } else if (terminal === "return") {
      this.line("Ok(runtime::AsyncCompletion::Return(value)) => {");
      this.indent += 1;
      this.withAsyncLocals(new Set(exitLocals), () => handlers.returned("value"));
      this.indent -= 1;
      this.line("},");
      this.line("Ok(runtime::AsyncCompletion::Fallthrough) | Ok(runtime::AsyncCompletion::Suspended) => unreachable!(\"scriptc invariant: invalid async return completion\"),");
    } else {
      this.line("Ok(runtime::AsyncCompletion::Suspended) => {},");
      this.line("Ok(runtime::AsyncCompletion::Return(value)) => {");
      this.indent += 1;
      this.withAsyncLocals(new Set(exitLocals), () => handlers.returned("value"));
      this.indent -= 1;
      this.line("},");
      this.line("Ok(runtime::AsyncCompletion::Fallthrough) => unreachable!(\"scriptc invariant: invalid async suspension completion\"),");
    }
    this.line("Err(reason) => {");
    this.indent += 1;
    this.withAsyncLocals(new Set(exitLocals), () => handlers.thrown("reason"));
    this.indent -= 1;
    this.line("},");
    this.indent -= 1;
    this.line("}");
    this.line("return;");
  }

  private emitAsyncProtectedContinuation(
    dependencyExpr: string,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (value: string) => void,
  ): void {
    const result = this.currentAsyncResult;
    if (result === null) {
      this.unsupported("protected async continuation without a result promise", this.currentFunction?.loc);
    }
    const dependency = `sc_async_dependency_${this.temporary++}`;
    const nextResult = `sc_async_result_${this.temporary++}`;
    const outcome = `sc_async_outcome_${this.temporary++}`;
    const guard = `sc_async_guard_${this.temporary++}`;
    const value = `sc_async_value_${this.temporary++}`;
    this.line(`let ${dependency} = ${dependencyExpr};`);
    this.line(`let ${nextResult} = ${result}.clone();`);
    const continuationLocals = new Set(this.currentAsyncLocals ?? []);
    const captures = [...continuationLocals].map((localId) => ({
      localId,
      capture: `sc_async_capture_${this.temporary++}`,
    }));
    for (const capture of captures) {
      this.line(`let ${capture.capture} = ${mangleLocal(capture.localId)}.clone();`);
    }
    this.line(`runtime::promise_then(&${dependency}, Box::new(move |${outcome}| {`);
    this.indent += 1;
    this.line(`let ${guard} = ${nextResult}.clone();`);
    this.line(`runtime::promise_run_segment(&${guard}, move || {`);
    this.indent += 1;
    this.line(`let ${result} = ${nextResult};`);
    for (const capture of captures) {
      this.line(`let ${mangleLocal(capture.localId)} = ${capture.capture};`);
    }
    this.line(`match ${outcome} {`);
    this.indent += 1;
    this.line(`Ok(${value}) => {`);
    this.indent += 1;
    this.withAsyncLocals(new Set(continuationLocals), () => consume(value));
    this.indent -= 1;
    this.line("},");
    this.line("Err(reason) => {");
    this.indent += 1;
    this.withAsyncLocals(new Set(exitLocals), () => handlers.thrown("reason"));
    this.indent -= 1;
    this.line("},");
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("});");
    this.indent -= 1;
    this.line("}));");
  }

  private emitAsyncProtectedValue(
    expr: IrExpr,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (value: string) => void,
  ): void {
    const awaited = this.awaitExpression(expr);
    if (awaited !== null) {
      this.emitAsyncProtectedContinuation(this.emitAwaitDependency(awaited), exitLocals, handlers, consume);
      return;
    }
    if (expr.kind === "unionWrap" && this.containsAsyncSuspension(expr.value)) {
      const union = this.union(expr.unionId, expr.loc);
      const arm = union.arms[expr.tag];
      if (arm === undefined || this.isUnit(arm)) {
        this.unsupported(`protected async union wrapper '${expr.unionId}:${expr.tag}'`, expr.loc);
      }
      const variant = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}`;
      this.emitAsyncProtectedValue(
        expr.value,
        exitLocals,
        handlers,
        (value) => consume(`${variant}(${value})`),
      );
      return;
    }
    if (expr.kind === "bin") {
      this.emitAsyncProtectedValue(expr.left, exitLocals, handlers, (left) => {
        this.emitAsyncProtectedValue(
          expr.right,
          exitLocals,
          handlers,
          (right) => consume(this.emitBinaryValues(expr, left, right)),
        );
      });
      return;
    }
    if (expr.kind === "toString") {
      this.emitAsyncProtectedValue(
        expr.operand,
        exitLocals,
        handlers,
        (value) => consume(this.emitToStringValue(expr.operand.type, value, expr.loc)),
      );
      return;
    }
    if (expr.kind === "strConcat") {
      this.emitAsyncProtectedValue(expr.left, exitLocals, handlers, (left) => {
        this.emitAsyncProtectedValue(
          expr.right,
          exitLocals,
          handlers,
          (right) => consume(`runtime::string_concat(&(${left}), &(${right}))`),
        );
      });
      return;
    }
    if (expr.kind === "arrayGet") {
      this.emitAsyncProtectedValue(expr.arr, exitLocals, handlers, (array) => {
        this.emitAsyncProtectedValue(
          expr.index,
          exitLocals,
          handlers,
          (index) => consume(this.emitArrayGetValues(expr, array, index)),
        );
      });
      return;
    }
    if (expr.kind === "mapIntrinsic") {
      this.emitAsyncProtectedValue(expr.receiver, exitLocals, handlers, (receiver) => {
        this.emitAsyncProtectedValues(expr.args, exitLocals, handlers, (args) => {
          consume(this.emitMapIntrinsicValues(expr, receiver, args));
        });
      });
      return;
    }
    if (this.containsAsyncSuspension(expr)) {
      this.unsupported("nested async value inside a Rust protected segment", expr.loc);
    }
    const value = `sc_async_value_${this.temporary++}`;
    this.line(`let ${value} = ${this.emitExpr(expr)};`);
    consume(value);
  }

  private emitAsyncProtectedForOf(
    stmt: Extract<IrStmt, { kind: "forOf" }>,
    remaining: readonly IrStmt[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    loc: SrcLoc,
  ): void {
    const result = this.currentAsyncResult;
    const fn = this.currentFunction;
    if (result === null || fn?.async !== true) {
      this.unsupported("protected async for-of outside an async function", stmt.loc);
    }
    if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled protected async for-of", stmt.loc);
    if (stmt.iterable.type.kind !== "array") this.unsupported("protected async for-of over a non-array", stmt.loc);
    if (this.containsAsyncSuspension(stmt.iterable)) {
      this.unsupported("async suspension in a protected for-of iterable", stmt.loc);
    }
    if (this.containsLoopControl(stmt.body)) {
      this.unsupported("break or continue in a protected suspended async for-of", stmt.loc);
    }

    const loopLocals = new Set(this.currentAsyncLocals ?? []);
    const locals = [...loopLocals].map((localId) => this.local(localId, stmt.loc));
    const local = this.local(stmt.localId, stmt.loc);
    const helper = `sc_async_protected_for_of_${this.temporary++}`;
    const array = `sc_async_for_of_array_${this.temporary++}`;
    const index = `sc_async_for_of_index_${this.temporary++}`;
    const arrayType = this.rustType(stmt.iterable.type, stmt.loc);
    const params = [
      `${result}: runtime::JsPromise<${this.rustType(fn.returnType, stmt.loc)}>`,
      `${array}: ${arrayType}`,
      `${index}: f64`,
      ...locals.map((candidate) =>
        `${mangleLocal(candidate.id)}: runtime::JsCell<${this.rustType(candidate.type, stmt.loc)}>`
      ),
    ];
    const call = (nextIndex: string) => `${helper}(${[
      `${result}.clone()`,
      `${array}.clone()`,
      nextIndex,
      ...locals.map((candidate) => `${mangleLocal(candidate.id)}.clone()`),
    ].join(", ")});`;

    this.line(`let ${array} = ${this.emitExpr(stmt.iterable)};`);
    this.line(`fn ${helper}(${params.join(", ")}) {`);
    this.indent += 1;
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.line(`if ${index} < runtime::array_len(&${array}) {`);
      this.indent += 1;
      this.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`);
      const iterationLocals = new Set(loopLocals);
      iterationLocals.add(local.id);
      this.withAsyncLocals(iterationLocals, () => {
        this.emitAsyncProtectedSequence(stmt.body, exitLocals, {
          fallthrough: () => this.withAsyncLocals(new Set(loopLocals), () => {
            this.line(call(`${index} + 1.0_f64`));
            this.line("return;");
          }),
          returned: handlers.returned,
          thrown: handlers.thrown,
        }, loc);
      });
      this.indent -= 1;
      this.line("} else {");
      this.indent += 1;
      this.withAsyncLocals(new Set(loopLocals), () => {
        this.emitAsyncProtectedSequence(remaining, exitLocals, handlers, loc);
      });
      this.indent -= 1;
      this.line("}");
    });
    this.indent -= 1;
    this.line("}");
    this.line(call("0.0_f64"));
  }

  private emitAsyncProtectedConsole(
    expr: Extract<IrExpr, { kind: "intrinsic" }>,
    remaining: readonly IrStmt[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    loc: SrcLoc,
    index = 0,
    values: { name: string; type: IrType; loc: SrcLoc }[] = [],
  ): void {
    const result = this.currentAsyncResult;
    if (result === null) this.unsupported("protected async console without a result promise", expr.loc);
    const arg = expr.args[index];
    if (arg === undefined) {
      const method = expr.name === "console.log" ? "console_log" : "console_error";
      this.line(`runtime::${method}(&[${values.map((value) =>
        this.displayValue(value.name, value.type, value.loc)).join(", ")}]);`);
      this.emitAsyncProtectedSequence(remaining, exitLocals, handlers, loc);
      return;
    }
    if (this.containsAsyncSuspension(arg)) {
      this.emitAsyncProtectedValue(
        arg,
        exitLocals,
        handlers,
        (value) => {
          this.emitAsyncProtectedConsole(expr, remaining, exitLocals, handlers, loc, index + 1, [
            ...values,
            { name: value, type: arg.type, loc: arg.loc },
          ]);
        },
      );
      return;
    }
    const value = `sc_async_argument_${this.temporary++}`;
    this.line(`let ${value} = ${this.emitExpr(arg)};`);
    this.emitAsyncProtectedConsole(
      expr,
      remaining,
      exitLocals,
      handlers,
      loc,
      index + 1,
      [...values, { name: value, type: arg.type, loc: arg.loc }],
    );
  }

  private emitAsyncCatch(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    remaining: readonly IrStmt[],
    outerLocals: ReadonlySet<string>,
    reason: string,
    onComplete: (() => void) | null,
  ): void {
    if (stmt.catchBody === null) {
      this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "throw", reason }, onComplete);
      return;
    }
    if (stmt.catchLocalId === null) {
      this.line(`let _ = ${reason};`);
    } else {
      const local = this.local(stmt.catchLocalId, stmt.loc);
      this.line(`let ${mangleLocal(local.id)}: runtime::JsCell<runtime::Caught> = runtime::cell_new(${reason});`);
      this.currentAsyncLocals?.add(local.id);
    }
    this.emitAsyncProtectedSequence(stmt.catchBody, outerLocals, {
      fallthrough: () => this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "fallthrough" }, onComplete),
      returned: (value) => this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "return", value }, onComplete),
      thrown: (catchReason) => this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "throw", reason: catchReason }, onComplete),
    }, stmt.loc);
  }

  private emitAsyncFinally(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    remaining: readonly IrStmt[],
    outerLocals: ReadonlySet<string>,
    pending: RustAsyncCompletion,
    onComplete: (() => void) | null,
  ): void {
    if (stmt.finallyBody === null) {
      this.emitAsyncCompletion(remaining, pending, onComplete);
      return;
    }
    this.emitAsyncProtectedSequence(stmt.finallyBody, outerLocals, {
      fallthrough: () => this.emitAsyncCompletion(remaining, pending, onComplete),
      returned: (value) => this.emitAsyncCompletion(remaining, { kind: "return", value }, onComplete),
      thrown: (reason) => this.emitAsyncCompletion(remaining, { kind: "throw", reason }, onComplete),
    }, stmt.loc);
  }

  private emitAsyncCompletion(
    remaining: readonly IrStmt[],
    completion: RustAsyncCompletion,
    onComplete: (() => void) | null,
  ): void {
    const result = this.currentAsyncResult;
    if (result === null) this.unsupported("async completion without a result promise", this.currentFunction?.loc);
    if (completion.kind === "fallthrough") {
      this.emitAsyncStatements(remaining, onComplete);
    } else if (completion.kind === "return") {
      this.line(`let _ = runtime::promise_fulfill(&${result}, ${completion.value});`);
    } else {
      this.line(`let _ = runtime::promise_reject(&${result}, ${completion.reason});`);
    }
  }

  private withAsyncLocals<T>(locals: Set<string>, emit: () => T): T {
    const previous = this.currentAsyncLocals;
    this.currentAsyncLocals = locals;
    try {
      return emit();
    } finally {
      this.currentAsyncLocals = previous;
    }
  }

  private emitAsyncResumeHelper(
    statements: readonly IrStmt[],
    onComplete: (() => void) | null,
    liveLocals: ReadonlySet<string>,
    loc: SrcLoc,
    prefix: string,
  ): () => void {
    const result = this.currentAsyncResult;
    const fn = this.currentFunction;
    if (result === null || fn?.async !== true) {
      this.unsupported("async continuation helper outside an async function", loc);
    }
    const helper = `sc_async_${prefix}_${this.temporary++}`;
    const locals = [...liveLocals].map((localId) => this.local(localId, loc));
    const params = [
      `${result}: runtime::JsPromise<${this.rustType(fn.returnType, loc)}>`,
      ...locals.map((local) =>
        `${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, loc)}>`
      ),
    ];
    const call = `${helper}(${[
      `${result}.clone()`,
      ...locals.map((local) => `${mangleLocal(local.id)}.clone()`),
    ].join(", ")});`;
    this.line(`fn ${helper}(${params.join(", ")}) {`);
    this.indent += 1;
    this.withAsyncLocals(new Set(liveLocals), () => this.emitAsyncStatements(statements, onComplete));
    this.indent -= 1;
    this.line("}");
    return () => {
      this.line(call);
      this.line("return;");
    };
  }

  private emitAsyncValue(expr: IrExpr, consume: (value: string) => void): void {
    const awaited = this.awaitExpression(expr);
    if (awaited !== null) {
      this.emitAsyncContinuation(this.emitAwaitDependency(awaited), consume, null);
      return;
    }
    if (expr.kind === "unionWrap" && this.containsAsyncSuspension(expr.value)) {
      const union = this.union(expr.unionId, expr.loc);
      const arm = union.arms[expr.tag];
      if (arm === undefined || this.isUnit(arm)) {
        this.unsupported(`async union wrapper '${expr.unionId}:${expr.tag}'`, expr.loc);
      }
      const variant = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}`;
      this.emitAsyncValue(expr.value, (value) => consume(`${variant}(${value})`));
      return;
    }
    if (expr.kind === "bin") {
      this.emitAsyncValue(expr.left, (left) => {
        this.emitAsyncValue(expr.right, (right) => consume(this.emitBinaryValues(expr, left, right)));
      });
      return;
    }
    if (expr.kind === "toString") {
      this.emitAsyncValue(
        expr.operand,
        (value) => consume(this.emitToStringValue(expr.operand.type, value, expr.loc)),
      );
      return;
    }
    if (expr.kind === "strConcat") {
      this.emitAsyncValue(expr.left, (left) => {
        this.emitAsyncValue(expr.right, (right) => consume(`runtime::string_concat(&(${left}), &(${right}))`));
      });
      return;
    }
    if (expr.kind === "arrayGet") {
      this.emitAsyncValue(expr.arr, (array) => {
        this.emitAsyncValue(expr.index, (index) => consume(this.emitArrayGetValues(expr, array, index)));
      });
      return;
    }
    if (expr.kind === "mapIntrinsic") {
      this.emitAsyncValue(expr.receiver, (receiver) => {
        this.emitAsyncValues(expr.args, (args) => {
          consume(this.emitMapIntrinsicValues(expr, receiver, args));
        });
      });
      return;
    }
    if (expr.kind === "recordLit") {
      this.emitAsyncRecord(expr, consume);
      return;
    }
    if (expr.kind === "arrIntrinsic") {
      this.emitAsyncValue(expr.receiver, (receiver) => {
        this.emitAsyncValues(expr.args, (args) => {
          consume(this.emitArrayIntrinsicValues(expr, receiver, args));
        });
      });
      return;
    }
    if (this.containsAsyncSuspension(expr)) {
      this.unsupported("nested async value in the Rust state-machine subset", expr.loc);
    }
    const value = `sc_async_value_${this.temporary++}`;
    this.line(`let ${value} = ${this.emitExpr(expr)};`);
    consume(value);
  }

  private emitAsyncRecord(
    expr: Extract<IrExpr, { kind: "recordLit" }>,
    consume: (value: string) => void,
    index = 0,
    values = new Map<string, string>(),
  ): void {
    if (expr.type.kind !== "record") this.unsupported("async record literal with a non-record type", expr.loc);
    const shape = this.records.get(expr.type.shapeId);
    if (shape === undefined) this.unsupported(`unknown record shape '${expr.type.shapeId}'`, expr.loc);
    const entry = expr.fields[index];
    if (entry !== undefined) {
      if (entry.overflow || entry.drop) this.unsupported("async record overflow/drop fields", expr.loc);
      this.emitAsyncValue(entry.value, (value) => {
        const next = new Map(values);
        next.set(entry.name, value);
        this.emitAsyncRecord(expr, consume, index + 1, next);
      });
      return;
    }
    const fields = shape.fields.map((field) => {
      const value = values.get(field.name);
      if (value === undefined) this.unsupported(`missing async record field '${shape.id}.${field.name}'`, expr.loc);
      return `${mangleField(field.name)}: ${this.isEdgeValue(field.type) ? `Some(${value})` : value}`;
    }).join(", ");
    consume(`runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} })`);
  }

  private emitAsyncValues(
    exprs: readonly IrExpr[],
    consume: (values: string[]) => void,
    index = 0,
    values: string[] = [],
  ): void {
    const expr = exprs[index];
    if (expr === undefined) {
      consume(values);
      return;
    }
    this.emitAsyncValue(expr, (value) => {
      this.emitAsyncValues(exprs, consume, index + 1, [...values, value]);
    });
  }

  private emitAsyncProtectedValues(
    exprs: readonly IrExpr[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (values: string[]) => void,
    index = 0,
    values: string[] = [],
  ): void {
    const expr = exprs[index];
    if (expr === undefined) {
      consume(values);
      return;
    }
    this.emitAsyncProtectedValue(expr, exitLocals, handlers, (value) => {
      this.emitAsyncProtectedValues(
        exprs,
        exitLocals,
        handlers,
        consume,
        index + 1,
        [...values, value],
      );
    });
  }

  private emitAsyncConsole(
    expr: Extract<IrExpr, { kind: "intrinsic" }>,
    remaining: readonly IrStmt[],
    index = 0,
    values: { name: string; type: IrType; loc: SrcLoc }[] = [],
    onComplete: (() => void) | null = null,
  ): void {
    const arg = expr.args[index];
    if (arg === undefined) {
      const method = expr.name === "console.log" ? "console_log" : "console_error";
      this.line(`runtime::${method}(&[${values.map((value) =>
        this.displayValue(value.name, value.type, value.loc)).join(", ")}]);`);
      this.emitAsyncStatements(remaining, onComplete);
      return;
    }
    if (this.containsAsyncSuspension(arg)) {
      this.emitAsyncValue(
        arg,
        (value) => this.emitAsyncConsole(expr, remaining, index + 1, [
          ...values,
          { name: value, type: arg.type, loc: arg.loc },
        ], onComplete),
      );
      return;
    }
    const value = `sc_async_argument_${this.temporary++}`;
    this.line(`let ${value} = ${this.emitExpr(arg)};`);
    this.emitAsyncConsole(
      expr,
      remaining,
      index + 1,
      [...values, { name: value, type: arg.type, loc: arg.loc }],
      onComplete,
    );
  }

  private emitAsyncContinuation(
    dependencyExpr: string,
    consume: (value: string) => void,
    remaining: readonly IrStmt[] | null,
    onComplete: (() => void) | null = null,
  ): void {
    const result = this.currentAsyncResult;
    if (result === null) this.unsupported("async continuation without a result promise", this.currentFunction?.loc);
    const dependency = `sc_async_dependency_${this.temporary++}`;
    const nextResult = `sc_async_result_${this.temporary++}`;
    const outcome = `sc_async_outcome_${this.temporary++}`;
    const guard = `sc_async_guard_${this.temporary++}`;
    const value = `sc_async_value_${this.temporary++}`;
    this.line(`let ${dependency} = ${dependencyExpr};`);
    this.line(`let ${nextResult} = ${result}.clone();`);
    this.line(`runtime::promise_then(&${dependency}, Box::new(move |${outcome}| {`);
    this.indent += 1;
    this.line(`let ${guard} = ${nextResult}.clone();`);
    this.line(`runtime::promise_run_segment(&${guard}, move || {`);
    this.indent += 1;
    this.line(`let ${result} = ${nextResult};`);
    this.line(`let ${value} = runtime::promise_unwrap(${outcome});`);
    consume(value);
    if (remaining !== null) this.emitAsyncStatements(remaining, onComplete);
    this.indent -= 1;
    this.line("});");
    this.indent -= 1;
    this.line("}));");
    this.line("return;");
  }

  private emitStatements(statements: readonly IrStmt[]): void {
    for (const stmt of statements) this.emitStatement(stmt);
  }

  private emitStatement(stmt: IrStmt): void {
    switch (stmt.kind) {
      case "varDecl": {
        const local = this.local(stmt.localId, stmt.loc);
        if (this.localIsBoxed(local)) {
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
          if (this.localIsBoxed(initLocal)) {
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
        this.line(this.localIsBoxed(local)
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
      case "bytesSet": {
        if (stmt.arr.type.kind !== "bytes") this.unsupported("bytesSet on non-bytes", stmt.loc);
        const bytes = `sc_rt_${this.temporary++}`;
        const index = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        this.line(`{ let ${bytes} = ${this.emitExpr(stmt.arr)}; let ${index} = ${this.emitExpr(stmt.index)}; let ${value} = ${this.emitExpr(stmt.value)}; runtime::bytes_set(&${bytes}, ${index}, ${value}); }`);
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
      case "fieldSet": {
        const cls = this.classDef(stmt.className, stmt.loc);
        const field = cls.fields.find((candidate) => candidate.name === stmt.field);
        if (field === undefined) this.unsupported(`unknown class field '${stmt.className}.${stmt.field}'`, stmt.loc);
        const name = this.classFieldName(stmt.className, field.name, stmt.loc);
        const object = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        const stored = this.isEdgeValue(field.type) ? `Some(${value})` : value;
        this.line(`{ let ${object} = ${this.emitExpr(stmt.obj)}; let ${value} = ${this.emitExpr(stmt.value)}; ${object}.with_mut(|object| object.${name} = ${stored}); }`);
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
        if (this.capturedReturnDepth > 0) {
          this.line(`return runtime::Completion::Return(${value});`);
          return;
        }
        if (this.asyncProtectedReturnDepth > 0) {
          this.line(`return runtime::AsyncCompletion::Return(${value});`);
          return;
        }
        if (this.currentAsyncResult !== null && this.capturedReturnDepth === 0) {
          this.line(`let _ = runtime::promise_fulfill(&${this.currentAsyncResult}, ${value});`);
          this.line("return;");
          return;
        }
        this.line(stmt.value === null ? "return;" : `return ${value};`);
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
    if (this.capturedReturnDepth > 0) {
      this.line("return runtime::Completion::Return(value);");
    } else if (this.asyncProtectedReturnDepth > 0) {
      this.line("return runtime::AsyncCompletion::Return(value);");
    } else if (this.currentAsyncResult !== null) {
      this.line(`let _ = runtime::promise_fulfill(&${this.currentAsyncResult}, value);`);
      this.line("return;");
    } else {
      this.line("return value;");
    }
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
      case "nullish": {
        if (expr.left.type.kind !== "union") this.unsupported("nullish over a non-union", expr.loc);
        const union = this.union(expr.left.type.unionId, expr.loc);
        const left = `sc_rt_${this.temporary++}`;
        const unitPatterns = union.arms.flatMap((arm, tag) =>
          this.isUnit(arm) ? [`${this.unionName(union.id)}::${this.unionVariant(tag)}`] : []
        );
        if (unitPatterns.length === 0) this.unsupported("nullish union without a unit arm", expr.loc);
        if (expr.type.kind === "union" && expr.type.unionId === union.id) {
          return `{ let ${left} = ${this.emitExpr(expr.left)}; if matches!(&${left}, ${unitPatterns.join(" | ")}) { ${this.emitExpr(expr.right)} } else { ${left} } }`;
        }
        const arms = union.arms.map((arm, tag) => {
          const variant = `${this.unionName(union.id)}::${this.unionVariant(tag)}`;
          return this.isUnit(arm)
            ? `${variant} => ${this.emitExpr(expr.right)}`
            : `${variant}(payload) => payload`;
        }).join(", ");
        return `{ let ${left} = ${this.emitExpr(expr.left)}; match ${left} { ${arms} } }`;
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
        if (expr.method === "toUpperCase" && expr.args.length === 0) {
          return `runtime::string_to_upper_case(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "charAt" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_char_at(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "charCodeAt" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_char_code_at(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "repeat" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_repeat(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if ((expr.method === "indexOf" || expr.method === "includes") && expr.args[0] !== undefined) {
          const index = `runtime::string_index_of(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${expr.args[1] === undefined ? "0.0" : this.emitExpr(expr.args[1])})`;
          return expr.method === "includes" ? `(${index} >= 0.0)` : index;
        }
        if (expr.method === "startsWith" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_starts_with(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}))`;
        }
        if (expr.method === "endsWith" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_ends_with(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}))`;
        }
        if (expr.method === "slice") {
          return `runtime::string_slice(&(${this.emitExpr(expr.receiver)}), ${expr.args[0] === undefined ? "0.0" : this.emitExpr(expr.args[0])}, ${expr.args[1] === undefined ? "f64::INFINITY" : this.emitExpr(expr.args[1])})`;
        }
        if (expr.method === "trim" && expr.args.length === 0) {
          return `runtime::string_trim(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "split" && expr.args.length === 2 && expr.args[0] !== undefined && expr.args[1] !== undefined) {
          return `runtime::string_split(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${this.emitExpr(expr.args[1])})`;
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
        return this.emitToStringValue(expr.operand.type, this.emitExpr(expr.operand), expr.loc);
      }
      case "jsonStringify": {
        const value = this.emitExpr(expr.value);
        if (!this.isRustJsonCompatible(expr.value.type)) {
          this.unsupported(`JSON.stringify value '${expr.value.type.kind}'`, expr.loc);
        }
        const indent = (expr as typeof expr & { indent?: string }).indent;
        if (indent && expr.value.type.kind !== "f64" && expr.value.type.kind !== "bool" && expr.value.type.kind !== "string") {
          this.unsupported("JSON.stringify indentation for composite values", expr.loc);
        }
        return `runtime::json_stringify(&(${value}))`;
      }
      case "dynCheck": {
        if (expr.value.kind === "libCall" && expr.value.fn === "json.parse" && expr.value.args.length === 1) {
          const text = expr.value.args[0];
          if (text === undefined || text.type.kind !== "string" || !this.isRustJsonCompatible(expr.type)) {
            this.unsupported(`JSON.parse target '${expr.type.kind}'`, expr.loc);
          }
          return `runtime::json_parse_typed::<${this.rustType(expr.type, expr.loc)}>(&(${this.emitExpr(text)}))`;
        }
        this.unsupported("dynamic checked cast", expr.loc);
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
      case "bytesNew": {
        if (expr.type.kind !== "bytes") this.unsupported("bytes construction result", expr.loc);
        const elem = this.rustBytesElement(expr.type.elem);
        if (expr.source === null) return `runtime::bytes_empty::<${elem}>()`;
        if (expr.source.type.kind === "f64") {
          return `runtime::bytes_alloc::<${elem}>(${this.emitExpr(expr.source)})`;
        }
        if (expr.source.type.kind === "bytes") {
          return `runtime::bytes_copy(&(${this.emitExpr(expr.source)}))`;
        }
        if (expr.source.type.kind === "array" && expr.source.type.elem.kind === "f64") {
          return `runtime::bytes_from_array::<${elem}>(&(${this.emitExpr(expr.source)}))`;
        }
        this.unsupported(`bytes construction from '${expr.source.type.kind}'`, expr.loc);
      }
      case "bytesIntrinsic": {
        if (expr.receiver.type.kind !== "bytes") this.unsupported("bytes intrinsic receiver", expr.loc);
        if (expr.method === "readNum" && expr.args.length === 2) {
          const kind = expr.args[0];
          const offset = expr.args[1];
          if (kind?.kind !== "strLit" || offset === undefined) this.unsupported("bytes readNum arguments", expr.loc);
          return `runtime::bytes_read_num(&(${this.emitExpr(expr.receiver)}), "${this.rustString(kind.value)}", ${this.emitExpr(offset)})`;
        }
        if (expr.method === "writeNum" && expr.args.length === 3) {
          const kind = expr.args[0];
          const value = expr.args[1];
          const offset = expr.args[2];
          if (kind?.kind !== "strLit" || value === undefined || offset === undefined) this.unsupported("bytes writeNum arguments", expr.loc);
          return `runtime::bytes_write_num(&(${this.emitExpr(expr.receiver)}), "${this.rustString(kind.value)}", ${this.emitExpr(value)}, ${this.emitExpr(offset)})`;
        }
        if (expr.method === "length" && expr.args.length === 0) {
          return `runtime::bytes_len(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "byteLength" && expr.args.length === 0) {
          return `runtime::bytes_byte_len(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "get" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::bytes_get(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "slice" || expr.method === "subarray") {
          const start = expr.args[0] === undefined ? "0.0" : this.emitExpr(expr.args[0]);
          const end = expr.args[1] === undefined ? "f64::INFINITY" : this.emitExpr(expr.args[1]);
          return `runtime::bytes_slice(&(${this.emitExpr(expr.receiver)}), ${start}, ${end}, ${expr.method === "subarray"})`;
        }
        if (expr.method === "setFrom" && expr.args[0] !== undefined) {
          const offset = expr.args[1] === undefined ? "0.0" : this.emitExpr(expr.args[1]);
          return `runtime::bytes_set_from(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${offset})`;
        }
        if (expr.method === "toString" && expr.args[0] !== undefined) {
          const encoding = this.emitExpr(expr.args[0]);
          if (expr.args.length === 1) {
            return `runtime::bytes_to_string(&(${this.emitExpr(expr.receiver)}), &(${encoding}))`;
          }
          const start = expr.args[1];
          const end = expr.args[2];
          if (start === undefined || expr.args.length > 3) this.unsupported("bytes toString arguments", expr.loc);
          return `runtime::bytes_to_string_range(&(${this.emitExpr(expr.receiver)}), &(${encoding}), ${this.emitExpr(start)}, ${end === undefined ? "f64::INFINITY" : this.emitExpr(end)})`;
        }
        this.unsupported(`bytes intrinsic '${expr.method}'`, expr.loc);
      }
      case "mapNew": {
        if (expr.type.kind !== "map") this.unsupported("mapNew with a non-map type", expr.loc);
        const type = expr.type;
        const map = `sc_rt_${this.temporary++}`;
        const equality = this.mapKeyEquality("left", "right", type.key, expr.loc);
        const entries = (expr.seed ?? []).map(({ key, value }) => {
          const keyTemp = `sc_rt_${this.temporary++}`;
          const valueTemp = `sc_rt_${this.temporary++}`;
          return `let ${keyTemp} = ${this.emitExpr(key)}; let ${valueTemp} = ${this.emitExpr(value)}; runtime::map_set_by(&${map}, ${this.mapStoredKey(keyTemp, type.key)}, ${valueTemp}, |left, right| ${equality});`;
        }).join(" ");
        return `{ let ${map}: ${this.rustType(expr.type, expr.loc)} = runtime::map_new(); ${entries} ${map} }`;
      }
      case "mapIntrinsic":
        return this.emitMapIntrinsic(expr);
      case "setNew": {
        if (expr.type.kind !== "set") this.unsupported("setNew with a non-set type", expr.loc);
        const equality = this.mapKeyEquality("left", "right", expr.type.elem, expr.loc);
        if (expr.seed === undefined) return `runtime::set_new::<${this.rustType(expr.type.elem, expr.loc)}>()`;
        const seed = `sc_rt_${this.temporary++}`;
        const value = "value";
        const normalized = this.mapStoredKey(value, expr.type.elem);
        return `{ let ${seed} = ${this.emitExpr(expr.seed)}; runtime::set_from_array_by(&${seed}, |${value}| ${normalized}, |left, right| ${equality}) }`;
      }
      case "setIntrinsic":
        return this.emitSetIntrinsic(expr);
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
        if (expr.test !== "instanceof") {
          const type = { string: "runtime::JsString", number: "f64", boolean: "bool" }[expr.test];
          const test = `runtime::caught_is::<${type}>(&(${this.emitExpr(expr.value)}))`;
          return expr.negated ? `!(${test})` : test;
        }
        if (expr.className === undefined) {
          this.unsupported(`caught test '${expr.test}:${expr.className ?? ""}'`, expr.loc);
        }
        if (!RUNTIME_ERROR_CLASSES.has(expr.className)) {
          const meta = this.classMeta.get(expr.className);
          if (meta === undefined) this.unsupported(`caught test '${expr.test}:${expr.className}'`, expr.loc);
          const caught = `sc_rt_${this.temporary++}`;
          const object = `sc_rt_${this.temporary++}`;
          const type = this.rustType({ kind: "object", className: meta.def.name }, expr.loc);
          const sameHierarchy = `runtime::caught_is::<${type}>(&${caught})`;
          let test = meta.hierarchy
            ? `${sameHierarchy} && { let ${object} = runtime::caught_narrow::<${type}>(&${caught}); ${object}.with(|object| ${meta.pre} <= object.sc_class_pre && object.sc_class_pre <= ${meta.post}) }`
            : sameHierarchy;
          if (this.runtimeErrorAncestor(meta.def.name) !== null) {
            const value = `sc_rt_${this.temporary++}`;
            const variant = `${this.errorValueName()}::${this.errorValueVariant(meta)}`;
            const narrowed = meta.hierarchy
              ? `object.with(|object| ${meta.pre} <= object.sc_class_pre && object.sc_class_pre <= ${meta.post})`
              : "true";
            test = `(${test}) || (runtime::caught_is::<${this.errorValueName()}>(&${caught}) && { let ${value} = runtime::caught_narrow::<${this.errorValueName()}>(&${caught}); match &${value} { ${variant}(object) => ${narrowed}, _ => false, } })`;
          }
          const result = expr.negated ? `!(${test})` : test;
          return `{ let ${caught} = ${this.emitExpr(expr.value)}; ${result} }`;
        }
        {
          const error = RUNTIME_ERROR_CLASSES.get(expr.className);
          if (error === undefined) this.unsupported(`caught test '${expr.test}:${expr.className}'`, expr.loc);
          const caught = `sc_rt_${this.temporary++}`;
          if (this.errorClassRoots().length > 0) {
            const test = `sc_caught_is_error_class(&${caught}, "${this.rustString(error.lib)}")`;
            const result = expr.negated ? `!(${test})` : test;
            return `{ let ${caught} = ${this.emitExpr(expr.value)}; ${result} }`;
          }
          const subclassTests = [...this.classMeta.values()]
            .filter((meta) => meta === meta.root && this.runtimeErrorAncestor(meta.def.name) !== null)
            .filter((meta) => error.lib === "Error" || this.runtimeErrorAncestor(meta.def.name) === expr.className)
            .map((meta) => `runtime::caught_is::<${this.rustType({ kind: "object", className: meta.def.name }, expr.loc)}>(&${caught})`);
          const test = [
            `runtime::caught_is_error_class(&${caught}, "${this.rustString(error.lib)}")`,
            ...subclassTests,
          ].join(" || ");
          const wrapped = `{ let ${caught} = ${this.emitExpr(expr.value)}; ${test} }`;
          return expr.negated ? `!(${wrapped})` : wrapped;
        }
      case "caughtNarrow":
        if (expr.type.kind === "f64") return `runtime::caught_narrow::<f64>(&(${this.emitExpr(expr.value)}))`;
        if (expr.type.kind === "bool") return `runtime::caught_narrow::<bool>(&(${this.emitExpr(expr.value)}))`;
        if (expr.type.kind === "string") return `runtime::caught_narrow::<runtime::JsString>(&(${this.emitExpr(expr.value)}))`;
        if (expr.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(expr.type.className)) {
          const helper = this.errorClassRoots().length === 0 ? "runtime::caught_error_value" : "sc_caught_error_value";
          return `${helper}(&(${this.emitExpr(expr.value)}))`;
        }
        if (expr.type.kind === "object" && this.classMeta.has(expr.type.className)) {
          const meta = this.classMetaOf(expr.type.className, expr.loc);
          const type = this.rustType(expr.type, expr.loc);
          if (this.runtimeErrorAncestor(meta.def.name) !== null) {
            const caught = `sc_rt_${this.temporary++}`;
            const variant = `${this.errorValueName()}::${this.errorValueVariant(meta)}`;
            return `{ let ${caught} = ${this.emitExpr(expr.value)}; if runtime::caught_is::<${type}>(&${caught}) { runtime::caught_narrow::<${type}>(&${caught}) } else { match runtime::caught_narrow::<${this.errorValueName()}>(&${caught}) { ${variant}(value) => value, _ => unreachable!("scriptc invariant: narrowed caught Error has the wrong subclass"), } } }`;
          }
          return `runtime::caught_narrow::<${type}>(&(${this.emitExpr(expr.value)}))`;
        }
        this.unsupported("caught narrowing outside scalar and Error values", expr.loc);
      case "caughtCheck": {
        if (expr.type.kind !== "object") this.unsupported("caught check outside an object", expr.loc);
        const error = RUNTIME_ERROR_CLASSES.get(expr.className);
        if (error === undefined) this.unsupported(`caught check '${expr.className}'`, expr.loc);
        return `runtime::caught_check_error(&(${this.emitExpr(expr.value)}), "${this.rustString(error.lib)}")`;
      }
      case "fieldGet":
        if (RUNTIME_ERROR_CLASSES.has(expr.className) && (expr.field === "name" || expr.field === "message")) {
          const helper = this.errorClassRoots().length === 0 ? `runtime::error_${expr.field}` : `sc_error_${expr.field}`;
          return `${helper}(&(${this.emitExpr(expr.obj)}))`;
        }
        {
          const cls = this.classDef(expr.className, expr.loc);
          const field = cls.fields.find((candidate) => candidate.name === expr.field);
          if (field === undefined) this.unsupported(`unknown class field '${expr.className}.${expr.field}'`, expr.loc);
          const access = `object.${this.classFieldName(expr.className, field.name, expr.loc)}`;
          const result = this.isEdgeValue(field.type)
            ? `${access}.as_ref().expect("scriptc: cleared live class field").clone()`
            : this.needsClone(field.type) ? `${access}.clone()` : access;
          return `(${this.emitExpr(expr.obj)}).with(|object| ${result})`;
        }
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
      case "virtualCall": {
        const meta = this.classMetaOf(expr.className, expr.loc);
        const slot = meta.root.slots.find((candidate) =>
          candidate.method === expr.method && candidate.declarer.pre <= meta.pre && meta.pre <= candidate.declarer.post
        );
        if (slot === undefined) this.unsupported(`virtual method '${expr.className}.${expr.method}'`, expr.loc);
        const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const bindings = expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`).join(" ");
        const receiver = args[0];
        if (receiver === undefined) this.unsupported(`virtual call '${expr.className}.${expr.method}' without receiver`, expr.loc);
        const pre = `sc_rt_${this.temporary++}`;
        const implementations = new Map<string, { fn: IrFunction; tags: number[] }>();
        for (const dynamic of this.classMeta.values()) {
          if (dynamic.def.abstract || dynamic.root !== meta.root || dynamic.pre < meta.pre || dynamic.pre > meta.post) continue;
          const implementation = this.virtualImplementation(dynamic, slot);
          const entry = implementations.get(implementation.name);
          if (entry === undefined) implementations.set(implementation.name, { fn: implementation, tags: [dynamic.pre] });
          else entry.tags.push(dynamic.pre);
        }
        const callArgs = args.join(", ");
        const arms = [...implementations.values()].map(({ fn, tags }) =>
          `${tags.join(" | ")} => ${mangleFunction(fn.name)}(${callArgs}),`
        ).join(" ");
        return `{ ${bindings} let ${pre} = ${receiver}.with(|object| object.sc_class_pre); match ${pre} { ${arms} _ => unreachable!("scriptc invariant: invalid dynamic class"), } }`;
      }
      case "instanceOf": {
        if (expr.value.type.kind !== "object") this.unsupported("instanceof on a non-object", expr.loc);
        const runtimeTarget = RUNTIME_ERROR_CLASSES.get(expr.className);
        if (runtimeTarget !== undefined) {
          const value = `sc_rt_${this.temporary++}`;
          const ancestor = this.runtimeErrorAncestor(expr.value.type.className);
          if (ancestor !== null) {
            return `{ let ${value} = ${this.emitExpr(expr.value)}; let _ = ${value}; ${this.runtimeErrorIsA(ancestor, expr.className)} }`;
          }
          if (RUNTIME_ERROR_CLASSES.has(expr.value.type.className)) {
            const helper = this.errorClassRoots().length === 0 ? "runtime::error_is_class" : "sc_error_is_class";
            return `{ let ${value} = ${this.emitExpr(expr.value)}; ${helper}(&${value}, "${this.rustString(runtimeTarget.lib)}") }`;
          }
          return `{ let ${value} = ${this.emitExpr(expr.value)}; let _ = ${value}; false }`;
        }
        if (RUNTIME_ERROR_CLASSES.has(expr.value.type.className)) {
          const target = this.classMetaOf(expr.className, expr.loc);
          const value = `sc_rt_${this.temporary++}`;
          const variant = `${this.errorValueName()}::${this.errorValueVariant(target)}`;
          const test = target.hierarchy
            ? `object.with(|object| ${target.pre} <= object.sc_class_pre && object.sc_class_pre <= ${target.post})`
            : "true";
          return `{ let ${value} = ${this.emitExpr(expr.value)}; match &${value} { ${variant}(object) => ${test}, _ => false, } }`;
        }
        const target = this.classMetaOf(expr.className, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        return `{ let ${value} = ${this.emitExpr(expr.value)}; ${value}.with(|object| ${target.pre} <= object.sc_class_pre && object.sc_class_pre <= ${target.post}) }`;
      }
      case "instanceOfValue": {
        if (expr.value.type.kind !== "object" || expr.classValue.type.kind !== "classval") {
          this.unsupported("dynamic instanceof operands", expr.loc);
        }
        const value = `sc_rt_${this.temporary++}`;
        const target = `sc_rt_${this.temporary++}`;
        const pre = `sc_rt_${this.temporary++}`;
        const staticTarget = this.classMetaOf(expr.classValue.type.className, expr.loc);
        const arms = this.classSubtree(staticTarget).map((candidate) =>
          `${candidate.pre} => ${candidate.pre} <= ${pre} && ${pre} <= ${candidate.post},`
        ).join(" ");
        return `{ let ${value} = ${this.emitExpr(expr.value)}; let ${target} = ${this.emitExpr(expr.classValue)}; let ${pre} = ${value}.with(|object| object.sc_class_pre); match ${target} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
      }
      case "classRef":
        return String(this.classMetaOf(expr.className, expr.loc).pre);
      case "new": {
        const cls = this.classDef(expr.className, expr.loc);
        if (expr.type.kind !== "object" || expr.type.className !== cls.name) {
          this.unsupported(`constructor result for '${cls.name}'`, expr.loc);
        }
        const constructor = this.functions.get(`%${cls.name}.constructor`);
        if (constructor === undefined) this.unsupported(`missing constructor for '${cls.name}'`, expr.loc);
        const meta = this.classMetaOf(cls.name, expr.loc);
        const object = `sc_rt_${this.temporary++}`;
        const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const shapeFields = meta.hierarchy
          ? this.hierarchyFields(meta.root)
          : cls.fields.map((field) => ({ owner: meta, field }));
        const fields = shapeFields.map(({ owner, field }) => {
          const value = this.isEdgeValue(field.type) ? "None" : this.defaultValue(field.type, cls.loc);
          return `${this.classFieldStorageName(owner, field.name)}: ${value}`;
        }).join(", ");
        const classTag = meta.hierarchy ? `sc_class_pre: ${meta.pre}, ` : "";
        const bindings = expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`).join(" ");
        return `{ let ${object} = runtime::Gc::new(${this.classStructName(cls.name, expr.loc)} { ${classTag}${fields} }); ${bindings} ${mangleFunction(constructor.name)}(${[`${object}.clone()`, ...args].join(", ")}); ${object} }`;
      }
      case "newValue": {
        if (expr.callee.type.kind !== "classval") this.unsupported("newValue with non-class callee", expr.loc);
        const staticMeta = this.classMetaOf(expr.callee.type.className, expr.loc);
        const callee = `sc_rt_${this.temporary++}`;
        const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const bindings = [
          `let ${callee} = ${this.emitExpr(expr.callee)};`,
          ...expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`),
        ].join(" ");
        const arms = this.classSubtree(staticMeta).filter((dynamic) => !dynamic.def.abstract).map((dynamic) =>
          `${dynamic.pre} => ${this.classAllocation(dynamic, args, expr.loc)},`
        ).join(" ");
        return `{ ${bindings} match ${callee} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
      }
      case "upcast":
        if (expr.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(expr.type.className) &&
          expr.value.type.kind === "object" && this.classMeta.has(expr.value.type.className)) {
          const meta = this.classMetaOf(expr.value.type.className, expr.loc);
          return `${this.errorValueName()}::${this.errorValueVariant(meta)}(${this.emitExpr(expr.value)})`;
        }
        return this.emitExpr(expr.value);
      case "downcast":
        if (expr.value.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(expr.value.type.className) &&
          expr.type.kind === "object" && this.classMeta.has(expr.type.className)) {
          const meta = this.classMetaOf(expr.type.className, expr.loc);
          const value = `sc_rt_${this.temporary++}`;
          const variant = `${this.errorValueName()}::${this.errorValueVariant(meta)}`;
          const check = meta.hierarchy
            ? `if !object.with(|object| ${meta.pre} <= object.sc_class_pre && object.sc_class_pre <= ${meta.post}) { unreachable!("scriptc invariant: invalid Error subclass downcast"); }`
            : "";
          return `{ let ${value} = ${this.emitExpr(expr.value)}; match ${value} { ${variant}(object) => { ${check} object }, _ => unreachable!("scriptc invariant: invalid Error subclass downcast"), } }`;
        }
        return this.emitExpr(expr.value);
      case "libCall": {
        const arg = expr.args[0];
        if (expr.fn === "math.floor" && expr.args.length === 1 && arg !== undefined) {
          return `(${this.emitExpr(arg)}).floor()`;
        }
        if (expr.fn === "process.argv" && expr.args.length === 0) return "runtime::process_argv()";
        if (expr.fn === "process.platform" && expr.args.length === 0) return "runtime::process_platform()";
        if (expr.fn === "process.cwd" && expr.args.length === 0) return "runtime::process_cwd()";
        if (expr.fn === "process.pid" && expr.args.length === 0) return "runtime::process_pid()";
        if (expr.fn === "process.getuid" && expr.args.length === 0) return "runtime::process_getuid()";
        if (expr.fn === "process.getgid" && expr.args.length === 0) return "runtime::process_getgid()";
        if (expr.fn === "process.execPath" && expr.args.length === 0) return "runtime::process_exec_path()";
        if (expr.fn === "process.arch" && expr.args.length === 0) return "runtime::process_arch()";
        if (expr.fn === "process.versionsNode" && expr.args.length === 0) return "runtime::process_versions_node()";
        if (expr.fn === "process.versionsOpenssl" && expr.args.length === 0) return "runtime::process_versions_openssl()";
        if (expr.fn === "process.envGet" && expr.args.length === 1 && arg !== undefined) {
          if (expr.type.kind !== "union") this.unsupported("process.envGet without an optional result union", expr.loc);
          const union = this.union(expr.type.unionId, expr.loc);
          const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
          const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
          if (stringTag < 0 || undefinedTag < 0) this.unsupported("process.envGet result union shape", expr.loc);
          const name = this.unionName(union.id);
          return `match runtime::process_env_get(&(${this.emitExpr(arg)})) { Some(value) => ${name}::${this.unionVariant(stringTag)}(value), None => ${name}::${this.unionVariant(undefinedTag)}, }`;
        }
        if (expr.fn === "num.parseInt" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::number_parse_int(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])})`;
        }
        if ((expr.fn === "num.isNaN" || expr.fn === "number.isNaN") && expr.args.length === 1 && arg !== undefined) {
          return `(${this.emitExpr(arg)}).is_nan()`;
        }
        if (expr.fn === "number.isFinite" && expr.args.length === 1 && arg !== undefined) {
          return `(${this.emitExpr(arg)}).is_finite()`;
        }
        if ((expr.fn === "number.isInteger" || expr.fn === "number.isSafeInteger") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::${expr.fn === "number.isInteger" ? "number_is_integer" : "number_is_safe_integer"}(${this.emitExpr(arg)})`;
        }
        if (expr.fn === "error.toString" && expr.args.length === 1 && arg !== undefined) {
          const receiverExpr = this.stripCasts(arg);
          if (receiverExpr.type.kind === "object" && this.classMeta.has(receiverExpr.type.className)) {
            const receiver = `sc_rt_${this.temporary++}`;
            const nameField = this.classFieldName(receiverExpr.type.className, "name", expr.loc);
            const messageField = this.classFieldName(receiverExpr.type.className, "message", expr.loc);
            return `{ let ${receiver} = ${this.emitExpr(receiverExpr)}; ${receiver}.with(|object| runtime::error_to_string_parts(object.${nameField}.as_ref(), object.${messageField}.as_ref())) }`;
          }
          if (this.errorClassRoots().length > 0) {
            return `sc_error_to_string(&(${this.emitExpr(arg)}))`;
          }
          return `runtime::error_to_string(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "error.code" && expr.args.length === 1 && arg !== undefined) {
          if (expr.type.kind !== "union") this.unsupported("error.code without an optional result union", expr.loc);
          const union = this.union(expr.type.unionId, expr.loc);
          const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
          const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
          if (stringTag < 0 || undefinedTag < 0) this.unsupported("error.code result union shape", expr.loc);
          const name = this.unionName(union.id);
          return `match runtime::error_code(&(${this.emitExpr(arg)})) { Some(value) => ${name}::${this.unionVariant(stringTag)}(value), None => ${name}::${this.unionVariant(undefinedTag)}, }`;
        }
        if (expr.fn === "fs.readFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          const path = `sc_rt_${this.temporary++}`;
          return `{ let ${path} = ${this.emitExpr(arg)}; let _ = ${this.emitExpr(expr.args[1])}; runtime::fs_read_file(&${path}) }`;
        }
        if ((expr.fn === "fs.readFileSyncBuf" || expr.fn === "fs.readFileSyncBytes") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_read_file_bytes(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.readFdSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_read_fd(${this.emitExpr(arg)}, &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.readFdSyncBytes" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_read_fd_bytes(${this.emitExpr(arg)})`;
        }
        if (expr.fn === "fs.writeFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_write_file(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.writeFileSyncBytes" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_write_file_bytes(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fsp.readFileBytes" && expr.args.length === 1 && arg !== undefined) {
          const path = `sc_rt_${this.temporary++}`;
          return `{ let ${path} = ${this.emitExpr(arg)}; runtime::promise_from_sync(move || runtime::fs_read_file_bytes(&${path})) }`;
        }
        if (expr.fn === "fsp.readFile" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          const path = `sc_rt_${this.temporary++}`;
          const encoding = `sc_rt_${this.temporary++}`;
          return `{ let ${path} = ${this.emitExpr(arg)}; let ${encoding} = ${this.emitExpr(expr.args[1])}; runtime::promise_from_sync(move || { let _ = ${encoding}; runtime::fs_read_file(&${path}) }) }`;
        }
        if (expr.fn === "fsp.writeFile" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          const path = `sc_rt_${this.temporary++}`;
          const data = `sc_rt_${this.temporary++}`;
          return `{ let ${path} = ${this.emitExpr(arg)}; let ${data} = ${this.emitExpr(expr.args[1])}; runtime::promise_from_sync(move || runtime::fs_write_file(&${path}, &${data})) }`;
        }
        if (expr.fn === "fs.appendFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_append_file(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.existsSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_exists(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.mkdirSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_mkdir(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.rmSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_rm(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.rmdirSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_rmdir(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.readdirSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_readdir(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.realpathSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_realpath(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "os.tmpdir" && expr.args.length === 0) return "runtime::os_tmpdir()";
        if (expr.fn === "fs.mkdtempSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_mkdtemp(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.mkdirRecursiveSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_mkdir_recursive(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.rmOptsSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          return `runtime::fs_rm_options(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])}, ${this.emitExpr(expr.args[2])})`;
        }
        if (expr.fn === "fs.rmRetrySync" && expr.args.length === 5 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          const maxRetriesArg = expr.args[3];
          const retryDelayArg = expr.args[4];
          if (maxRetriesArg === undefined || retryDelayArg === undefined) this.unsupported("fs.rmRetrySync arguments", expr.loc);
          const path = `sc_rt_${this.temporary++}`;
          const recursive = `sc_rt_${this.temporary++}`;
          const force = `sc_rt_${this.temporary++}`;
          return `{ let ${path} = ${this.emitExpr(arg)}; let ${recursive} = ${this.emitExpr(expr.args[1])}; let ${force} = ${this.emitExpr(expr.args[2])}; let _ = ${this.emitExpr(maxRetriesArg)}; let _ = ${this.emitExpr(retryDelayArg)}; runtime::fs_rm_options(&${path}, ${recursive}, ${force}) }`;
        }
        if (expr.fn === "fs.unlinkSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_unlink(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.copyFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_copy_file(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.renameSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_rename(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.chmodSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_chmod(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])})`;
        }
        if (expr.fn === "fs.chownSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          return `runtime::fs_chown(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])}, ${this.emitExpr(expr.args[2])})`;
        }
        if (expr.fn === "fs.writeFileModeSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          return `runtime::fs_write_file_mode(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}), ${this.emitExpr(expr.args[2])})`;
        }
        if ((expr.fn === "fs.mkdirModeSync" || expr.fn === "fs.mkdirRecursiveModeSync") && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_mkdir_mode(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])}, ${expr.fn === "fs.mkdirRecursiveModeSync"})`;
        }
        if (expr.fn === "fs.accessSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_access(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])})`;
        }
        if (expr.fn === "fs.openSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_open(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.closeSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_close(${this.emitExpr(arg)})`;
        }
        if ((expr.fn === "fs.readSync" || expr.fn === "fs.writeSync") && expr.args.length === 5 && arg !== undefined) {
          const bytes = expr.args[1];
          const offset = expr.args[2];
          const length = expr.args[3];
          const position = expr.args[4];
          if (bytes === undefined || offset === undefined || length === undefined || position === undefined) {
            this.unsupported(`${expr.fn} arguments`, expr.loc);
          }
          const runtimeFn = expr.fn === "fs.readSync" ? "fs_read_sync" : "fs_write_sync";
          return `runtime::${runtimeFn}(${this.emitExpr(arg)}, &(${this.emitExpr(bytes)}), ${this.emitExpr(offset)}, ${this.emitExpr(length)}, ${this.emitExpr(position)})`;
        }
        if (expr.fn === "fs.writeStrSync" && expr.args.length === 4 && arg !== undefined) {
          const value = expr.args[1];
          const position = expr.args[2];
          const encoding = expr.args[3];
          if (value === undefined || position === undefined || encoding === undefined) this.unsupported("fs.writeStrSync arguments", expr.loc);
          return `runtime::fs_write_str_sync(${this.emitExpr(arg)}, &(${this.emitExpr(value)}), ${this.emitExpr(position)}, &(${this.emitExpr(encoding)}))`;
        }
        if (expr.fn === "cp.execSync" && expr.args.length === 11 && arg !== undefined) {
          const [argv, shell, input, hasInput, cwd, hasEnv, envPairs, timeout, stdoutMode, stderrMode] = expr.args.slice(1);
          if (argv === undefined || shell === undefined || input === undefined || hasInput === undefined ||
              cwd === undefined || hasEnv === undefined || envPairs === undefined || timeout === undefined ||
              stdoutMode === undefined || stderrMode === undefined) this.unsupported("cp.execSync arguments", expr.loc);
          return `runtime::child_exec_sync(&(${this.emitExpr(arg)}), &(${this.emitExpr(argv)}), ${this.emitExpr(shell)}, &(${this.emitExpr(input)}), ${this.emitExpr(hasInput)}, &(${this.emitExpr(cwd)}), ${this.emitExpr(hasEnv)}, &(${this.emitExpr(envPairs)}), ${this.emitExpr(timeout)}, ${this.emitExpr(stdoutMode)}, ${this.emitExpr(stderrMode)})`;
        }
        if ((expr.fn === "timers.setTimeout" || expr.fn === "timers.setTimeoutHandle" || expr.fn === "timers.setInterval") &&
            expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          if (arg.type.kind !== "func" || arg.type.params.length !== 0 || arg.type.ret.kind !== "void") {
            this.unsupported("setTimeout callback shape", expr.loc);
          }
          const callback = `sc_rt_${this.temporary++}`;
          const dispatch = this.emitClosureDispatch(callback, arg.type, [], expr.loc);
          const runtimeFn = expr.fn === "timers.setTimeout"
            ? "timer_set_timeout"
            : expr.fn === "timers.setTimeoutHandle" ? "timer_set_timeout_handle" : "timer_set_interval";
          return `{ let ${callback} = ${this.emitExpr(arg)}; runtime::${runtimeFn}(Box::new(move || { ${dispatch}; }), ${this.emitExpr(expr.args[1])}) }`;
        }
        if (expr.fn === "process.uptime" && expr.args.length === 0) return "runtime::process_uptime()";
        if (expr.fn === "perf.now" && expr.args.length === 0) return "runtime::performance_now()";
        if (expr.fn === "date.now" && expr.args.length === 0) return "runtime::date_now()";
        if (expr.fn === "process.activeResources" && expr.args.length === 0) return "runtime::process_active_resources()";
        const processSample = new Map<string, string>([
          ["process.availableMemory", "process_available_memory"],
          ["process.constrainedMemory", "process_constrained_memory"],
          ["process.cpuUser", "process_cpu_user"],
          ["process.cpuSystem", "process_cpu_system"],
          ["process.threadCpuUser", "process_thread_cpu_user"],
          ["process.threadCpuSystem", "process_thread_cpu_system"],
        ]).get(expr.fn);
        if (processSample !== undefined && expr.args.length === 0) return `runtime::${processSample}()`;
        const processDiff = new Map<string, string>([
          ["process.cpuUserDiff", "process_cpu_user"],
          ["process.cpuSystemDiff", "process_cpu_system"],
          ["process.threadCpuUserDiff", "process_thread_cpu_user"],
          ["process.threadCpuSystemDiff", "process_thread_cpu_system"],
        ]).get(expr.fn);
        if (processDiff !== undefined && expr.args.length === 1 && arg !== undefined) {
          return `(runtime::${processDiff}() - ${this.emitExpr(arg)})`;
        }
        if (expr.fn === "process.cpuPrevValidate" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::process_cpu_prev_validate(${this.emitExpr(arg)}, ${this.emitExpr(expr.args[1])})`;
        }
        if (expr.fn === "process.rusage" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::process_rusage(${this.emitExpr(arg)})`;
        }
        if (expr.fn === "tp.setTimeout" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::promise_timeout(${this.emitExpr(arg)})`;
        }
        if (expr.fn === "tp.setImmediate" && expr.args.length === 0) {
          return "runtime::promise_immediate()";
        }
        if (expr.fn === "atomics.wait" && expr.args.length === 4 && arg !== undefined) {
          const [index, expected, timeout] = expr.args.slice(1);
          if (index === undefined || expected === undefined || timeout === undefined) {
            this.unsupported("atomics.wait arguments", expr.loc);
          }
          return `runtime::atomics_wait(&(${this.emitExpr(arg)}), ${this.emitExpr(index)}, ${this.emitExpr(expected)}, ${this.emitExpr(timeout)})`;
        }
        if ((expr.fn === "timers.setImmediate" || expr.fn === "timers.queueMicrotask" || expr.fn === "process.nextTick") &&
            expr.args.length === 1 && arg !== undefined) {
          if (arg.type.kind !== "func" || arg.type.params.length !== 0 || arg.type.ret.kind !== "void") {
            this.unsupported(`${expr.fn} callback shape`, expr.loc);
          }
          const callback = `sc_rt_${this.temporary++}`;
          const dispatch = this.emitClosureDispatch(callback, arg.type, [], expr.loc);
          const runtimeFn = expr.fn === "timers.setImmediate"
            ? "timer_set_immediate"
            : expr.fn === "timers.queueMicrotask" ? "timer_queue_microtask" : "process_next_tick";
          return `{ let ${callback} = ${this.emitExpr(arg)}; runtime::${runtimeFn}(Box::new(move || { ${dispatch}; })) }`;
        }
        if (expr.fn === "timers.clearImmediate" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::timer_clear_immediate(${this.emitExpr(arg)})`;
        }
        if ((expr.fn === "timers.immediateUnref" || expr.fn === "timers.immediateRef") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::timer_set_immediate_ref(${this.emitExpr(arg)}, ${expr.fn === "timers.immediateRef"})`;
        }
        if (expr.fn === "timers.immediateHasRef" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::timer_immediate_has_ref(${this.emitExpr(arg)})`;
        }
        if ((expr.fn === "timers.clearTimeout" || expr.fn === "timers.clearInterval") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::timer_clear(${this.emitExpr(arg)})`;
        }
        if ((expr.fn === "timers.unref" || expr.fn === "timers.ref") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::timer_set_ref(${this.emitExpr(arg)}, ${expr.fn === "timers.ref"})`;
        }
        if (expr.fn === "timers.hasRef" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::timer_has_ref(${this.emitExpr(arg)})`;
        }
        if (expr.fn === "timers.refresh" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::timer_refresh(${this.emitExpr(arg)})`;
        }
        if (expr.fn === "cp.spawnSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::child_spawn_sync(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}), 0.0, &runtime::string(""), 0.0, 0.0, 0.0)`;
        }
        if (expr.fn === "cp.spawnSyncOpts" && expr.args.length === 7 && arg !== undefined) {
          const [argv, timeout, signal, stdinMode, stdoutMode, stderrMode] = expr.args.slice(1);
          if (argv === undefined || timeout === undefined || signal === undefined || stdinMode === undefined ||
              stdoutMode === undefined || stderrMode === undefined) this.unsupported("cp.spawnSyncOpts arguments", expr.loc);
          return `runtime::child_spawn_sync(&(${this.emitExpr(arg)}), &(${this.emitExpr(argv)}), ${this.emitExpr(timeout)}, &(${this.emitExpr(signal)}), ${this.emitExpr(stdinMode)}, ${this.emitExpr(stdoutMode)}, ${this.emitExpr(stderrMode)})`;
        }
        if (expr.fn === "cp.spawnSyncStdioStr" && expr.args.length === 5 && arg !== undefined) {
          const [argv, timeout, signal, stdio] = expr.args.slice(1);
          if (argv === undefined || timeout === undefined || signal === undefined || stdio === undefined) {
            this.unsupported("cp.spawnSyncStdioStr arguments", expr.loc);
          }
          return `runtime::child_spawn_sync_stdio(&(${this.emitExpr(arg)}), &(${this.emitExpr(argv)}), ${this.emitExpr(timeout)}, &(${this.emitExpr(signal)}), &(${this.emitExpr(stdio)}))`;
        }
        if ((expr.fn === "spawnRes.stdout" || expr.fn === "spawnRes.stderr") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::spawn_result_${expr.fn === "spawnRes.stdout" ? "stdout" : "stderr"}(&(${this.emitExpr(arg)}))`;
        }
        if ((expr.fn === "spawnRes.status" || expr.fn === "spawnRes.signal" || expr.fn === "spawnRes.error") && expr.args.length === 1 && arg !== undefined) {
          if (expr.type.kind !== "union") this.unsupported(`${expr.fn} without a union result`, expr.loc);
          const union = this.union(expr.type.unionId, expr.loc);
          const valueKind = expr.fn === "spawnRes.status" ? "f64" : expr.fn === "spawnRes.signal" ? "string" : "object";
          const emptyKind = expr.fn === "spawnRes.error" ? "undefinedT" : "nullT";
          const valueTag = union.arms.findIndex((arm) => arm.kind === valueKind);
          const emptyTag = union.arms.findIndex((arm) => arm.kind === emptyKind);
          if (valueTag < 0 || emptyTag < 0) this.unsupported(`${expr.fn} result union shape`, expr.loc);
          const name = this.unionName(union.id);
          const accessor = expr.fn.slice("spawnRes.".length);
          return `match runtime::spawn_result_${accessor}(&(${this.emitExpr(arg)})) { Some(value) => ${name}::${this.unionVariant(valueTag)}(value), None => ${name}::${this.unionVariant(emptyTag)}, }`;
        }
        if (expr.fn === "buffer.fromStr" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::buffer_from_string(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "buffer.concat" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::buffer_concat(&(${this.emitExpr(arg)}))`;
        }
        if ((expr.fn === "fs.statSync" || expr.fn === "fs.lstatSync") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_stat(&(${this.emitExpr(arg)}), ${expr.fn === "fs.statSync"})`;
        }
        if (expr.fn === "stats.isFile" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_file(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.isDirectory" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_directory(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.isSymbolicLink" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_symlink(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.size" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_size(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.blocks" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_blocks(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.nlink" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_nlink(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.atimeMs" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_atime_ms(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.mtimeMs" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_mtime_ms(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "path.join" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_join(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.resolve" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_resolve(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.normalize" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_normalize(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.dirname" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_dirname(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.extname" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_extname(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.isAbsolute" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_is_absolute(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.toNamespacedPath" && expr.args.length === 1 && arg !== undefined) {
          return this.emitExpr(arg);
        }
        if (expr.fn === "path.basename" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::path_basename(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "path.relative" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::path_relative(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "error.ctor" && expr.args.length === 2 && arg !== undefined &&
          expr.args[1] !== undefined && arg.type.kind === "object") {
          const error = RUNTIME_ERROR_CLASSES.get(arg.type.className);
          const receiverExpr = this.stripCasts(arg);
          if (error === undefined || receiverExpr.type.kind !== "object" ||
            !this.classMeta.has(receiverExpr.type.className)) {
            this.unsupported("Error subclass constructor", expr.loc);
          }
          const receiver = `sc_rt_${this.temporary++}`;
          const message = `sc_rt_${this.temporary++}`;
          const nameField = this.classFieldName(receiverExpr.type.className, "name", expr.loc);
          const messageField = this.classFieldName(receiverExpr.type.className, "message", expr.loc);
          const codeField = this.classFieldName(receiverExpr.type.className, "%code", expr.loc);
          return `{ let ${receiver} = ${this.emitExpr(receiverExpr)}; let ${message} = ${this.emitExpr(expr.args[1])}; ${receiver}.with_mut(|object| { object.${nameField} = runtime::string("${this.rustString(error.lib)}"); object.${messageField} = ${message}; object.${codeField} = runtime::empty_string(); }); }`;
        }
        if (expr.fn === "error.new" && expr.args.length === 1 && arg !== undefined && expr.type.kind === "object") {
          const error = RUNTIME_ERROR_CLASSES.get(expr.type.className);
          if (error === undefined) this.unsupported(`error.new result '${expr.type.className}'`, expr.loc);
          const value = `runtime::error_new("${this.rustString(error.lib)}", ${this.emitExpr(arg)})`;
          return this.errorClassRoots().length === 0 ? value : `${this.errorValueName()}::Builtin(${value})`;
        }
        if (expr.fn === "class.name" && expr.args.length === 1 && arg !== undefined && arg.type.kind === "classval") {
          const value = `sc_rt_${this.temporary++}`;
          const meta = this.classMetaOf(arg.type.className, expr.loc);
          const arms = this.classSubtree(meta).map((candidate) =>
            `${candidate.pre} => runtime::string("${this.rustString(candidate.def.jsName ?? "")}"),`
          ).join(" ");
          return `{ let ${value} = ${this.emitExpr(arg)}; match ${value} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
        }
        this.unsupported(`library call '${expr.fn}'`, expr.loc);
      }
      case "awaitExpr":
      case "awaitUnionExpr":
        this.unsupported("async suspension outside the Rust state-machine subset", expr.loc);
      case "promiseWithResolvers": {
        if (expr.type.kind !== "record") this.unsupported("Promise.withResolvers result shape", expr.loc);
        const record = this.records.get(expr.type.shapeId);
        const promiseType = record?.fields.find((field) => field.name === "promise")?.type;
        const resolverType = record?.fields.find((field) => field.name === "resolve")?.type;
        const rejectorType = record?.fields.find((field) => field.name === "reject")?.type;
        if (record === undefined || record.fields.length !== 3 || promiseType?.kind !== "promise" ||
          resolverType?.kind !== "func" || rejectorType?.kind !== "func") {
          this.unsupported("Promise.withResolvers record shape", expr.loc);
        }
        const resolverShape = this.closureShapeForType(resolverType, expr.loc);
        const rejectorShape = this.closureShapeForType(rejectorType, expr.loc);
        const rejectorVariant = this.promiseRejectorVariant(rejectorType, promiseType.inner, expr.loc);
        const promise = `sc_rt_${this.temporary++}`;
        const resolver = `sc_rt_${this.temporary++}`;
        const rejector = `sc_rt_${this.temporary++}`;
        const values = new Map([
          ["promise", promise],
          ["resolve", resolver],
          ["reject", rejector],
        ]);
        const fields = record.fields.map((field) => {
          const value = values.get(field.name);
          if (value === undefined) this.unsupported(`Promise.withResolvers field '${field.name}'`, expr.loc);
          return `${mangleField(field.name)}: Some(${value})`;
        }).join(", ");
        return `{ let ${promise} = runtime::promise_new::<${this.rustType(promiseType.inner, expr.loc)}>(); let ${resolver} = runtime::Gc::new(${this.closureName(resolverShape)}::PromiseResolver { promise: Some(${promise}.clone()) }); let ${rejector} = runtime::Gc::new(${this.closureName(rejectorShape)}::${rejectorVariant} { promise: Some(${promise}.clone()) }); runtime::Gc::new(${mangleRecordStruct(record.id)} { ${fields} }) }`;
      }
      case "newPromise": {
        if (expr.type.kind !== "promise" || expr.executor.type.kind !== "func") {
          this.unsupported("new Promise shape", expr.loc);
        }
        const promise = `sc_rt_${this.temporary++}`;
        const executor = `sc_rt_${this.temporary++}`;
        if (expr.executor.type.params.length === 0) {
          const dispatch = this.emitClosureDispatch(executor, expr.executor.type, [], expr.loc);
          return `{ let ${promise} = runtime::promise_new::<${this.rustType(expr.type.inner, expr.loc)}>(); let ${executor} = ${this.emitExpr(expr.executor)}; runtime::promise_run_segment(&${promise}, || { ${dispatch}; }); ${promise} }`;
        }
        if (expr.executor.type.params.length > 2) this.unsupported("new Promise executor arity", expr.loc);
        const resolverType = expr.executor.type.params[0];
        if (resolverType?.kind !== "func") this.unsupported("new Promise resolver shape", expr.loc);
        const shape = this.closureShapeForType(resolverType, expr.loc);
        const resolver = `sc_rt_${this.temporary++}`;
        const rejectorType = expr.executor.type.params[1];
        if (rejectorType === undefined) {
          const dispatch = this.emitClosureDispatch(executor, expr.executor.type, [resolver], expr.loc);
          return `{ let ${promise} = runtime::promise_new(); let ${executor} = ${this.emitExpr(expr.executor)}; let ${resolver} = runtime::Gc::new(${this.closureName(shape)}::PromiseResolver { promise: Some(${promise}.clone()) }); runtime::promise_run_segment(&${promise}, || { ${dispatch}; }); ${promise} }`;
        }
        if (rejectorType.kind !== "func") this.unsupported("new Promise rejector shape", expr.loc);
        const rejectorShape = this.closureShapeForType(rejectorType, expr.loc);
        const rejectorVariant = this.promiseRejectorVariant(rejectorType, expr.type.inner, expr.loc);
        const rejector = `sc_rt_${this.temporary++}`;
        const dispatch = this.emitClosureDispatch(executor, expr.executor.type, [resolver, rejector], expr.loc);
        return `{ let ${promise} = runtime::promise_new(); let ${executor} = ${this.emitExpr(expr.executor)}; let ${resolver} = runtime::Gc::new(${this.closureName(shape)}::PromiseResolver { promise: Some(${promise}.clone()) }); let ${rejector} = runtime::Gc::new(${this.closureName(rejectorShape)}::${rejectorVariant} { promise: Some(${promise}.clone()) }); runtime::promise_run_segment(&${promise}, || { ${dispatch}; }); ${promise} }`;
      }
      case "intrinsic":
        if (expr.name === "promise.reject") {
          if (expr.type.kind !== "promise" || expr.args.length !== 1) {
            this.unsupported("Promise.reject shape", expr.loc);
          }
          const reason = expr.args[0];
          if (reason === undefined || reason.type.kind !== "object") {
            this.unsupported("Promise.reject reason outside typed Error objects", expr.loc);
          }
          return `runtime::promise_rejected::<${this.rustType(expr.type.inner, expr.loc)}>(runtime::caught_value(${this.emitExpr(reason)}))`;
        }
        if (expr.name === "promise.resolve") {
          if (expr.type.kind !== "promise" || expr.args.length > 1) {
            this.unsupported("Promise.resolve shape", expr.loc);
          }
          return `runtime::promise_resolved(${expr.args[0] === undefined ? "()" : this.emitExpr(expr.args[0])})`;
        }
        if (expr.name === "promise.all") {
          if (expr.type.kind !== "promise") this.unsupported("Promise.all result shape", expr.loc);
          const entries = expr.args[0];
          if (entries === undefined || entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
            this.unsupported("Promise.all argument shape", expr.loc);
          }
          if (expr.type.inner.kind === "void") {
            if (entries.type.elem.inner.kind !== "void") this.unsupported("Promise.all void entry shape", expr.loc);
            return `runtime::promise_all_void(&(${this.emitExpr(entries)}))`;
          }
          if (expr.type.inner.kind !== "array" ||
            typeKey(entries.type.elem.inner) !== typeKey(expr.type.inner.elem)) {
            this.unsupported("Promise.all with differing Rust value types", expr.loc);
          }
          return `runtime::promise_all(&(${this.emitExpr(entries)}))`;
        }
        if (expr.name === "promise.race") {
          if (expr.type.kind !== "promise") this.unsupported("Promise.race result shape", expr.loc);
          const raceInner = expr.type.inner;
          if (expr.args.length === 0 || expr.args.some((arg) => arg.type.kind !== "promise")) {
            this.unsupported("Promise.race entry shape", expr.loc);
          }
          const result = `sc_rt_${this.temporary++}`;
          const entries = expr.args.map((arg) => {
            if (arg.type.kind !== "promise") this.unsupported("Promise.race entry shape", expr.loc);
            const entry = `sc_rt_${this.temporary++}`;
            const adapted = this.emitPromiseRaceValue(arg.type.inner, raceInner, "value", expr.loc);
            return `let ${entry} = ${this.emitExpr(arg)}; runtime::promise_race_add(&${result}, &${entry}, |value| ${adapted});`;
          }).join(" ");
          return `{ let ${result}: runtime::JsPromise<${this.rustType(raceInner, expr.loc)}> = runtime::promise_new(); ${entries} ${result} }`;
        }
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
      case "seqExpr": {
        // Keep the straight-line statements inside the expression block.
        // Hoisting them into the surrounding Rust statement would run a
        // right-hand sequence before effects in the containing left side.
        const start = this.lines.length;
        const previousIndent = this.indent;
        this.indent = 0;
        this.emitStatements(expr.stmts);
        const result = this.emitExpr(expr.result);
        const statements = this.lines.splice(start).join(" ");
        this.indent = previousIndent;
        return `{ ${statements} ${result} }`;
      }
      case "incDec": {
        const old = `sc_rt_${this.temporary++}`;
        const next = `sc_rt_${this.temporary++}`;
        const read = this.emitRead(expr.localId, expr.type, expr.loc);
        const operation = expr.op === "+" ? "+" : "-";
        const result = expr.prefix ? next : old;
        return `{ let ${old} = ${read}; let ${next} = ${old} ${operation} 1.0; ${this.assignmentExpr(expr.localId, next, expr.loc)} ${result} }`;
      }
      case "fieldIncDec": {
        const cls = this.classDef(expr.className, expr.loc);
        const field = cls.fields.find((candidate) => candidate.name === expr.field);
        if (field === undefined) this.unsupported(`unknown class field '${expr.className}.${expr.field}'`, expr.loc);
        if (expr.fieldDyn || field.type.kind !== "f64") {
          this.unsupported(`increment/decrement of checked-dynamic class field '${expr.className}.${expr.field}'`, expr.loc);
        }
        const object = `sc_rt_${this.temporary++}`;
        const old = `sc_rt_${this.temporary++}`;
        const next = `sc_rt_${this.temporary++}`;
        const operation = expr.op === "+" ? "+" : "-";
        const result = expr.prefix ? next : old;
        const name = this.classFieldName(expr.className, field.name, expr.loc);
        return `{ let ${object} = ${this.emitExpr(expr.obj)}; ${object}.with_mut(|object| { let ${old} = object.${name}; let ${next} = ${old} ${operation} 1.0; object.${name} = ${next}; ${result} }) }`;
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
    return `{ ${bindings} ${this.emitClosureDispatch(callee, expr.callee.type, args, expr.loc)} }`;
  }

  private emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string {
    const shape = this.closureShapeForType(type, loc);
    if (args.length !== shape.type.params.length) this.unsupported("closure dispatch argument arity", loc);
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
    });
    const resolverType = this.promiseResolverTypes.get(typeKey(shape.type));
    if (resolverType !== undefined) {
      const expectedArity = resolverType.kind === "void" ? 0 : 1;
      if (args.length !== expectedArity) this.unsupported("Promise resolver argument arity", loc);
      const value = args[0] ?? "()";
      arms.push(`${this.closureName(shape)}::PromiseResolver { promise } => { let promise = promise.as_ref().expect("scriptc: cleared live Promise resolver"); let _ = runtime::promise_fulfill(promise, ${value}); }`);
    }
    const rejectorTypes = this.promiseRejectorTypes.get(typeKey(shape.type)) ?? [];
    if (rejectorTypes.length > 0) {
      if (args.length !== 1) this.unsupported("Promise rejector argument arity", loc);
      const reason = args[0];
      if (reason === undefined) this.unsupported("Promise rejector without a reason", loc);
      for (let index = 0; index < rejectorTypes.length; index += 1) {
        arms.push(`${this.closureName(shape)}::PromiseRejector${index} { promise } => { let promise = promise.as_ref().expect("scriptc: cleared live Promise rejector"); let _ = runtime::promise_reject(promise, runtime::caught_value(${reason})); }`);
      }
    }
    return `${callee}.with(|closure| match closure { ${arms.join(", ")} })`;
  }

  private emitBinary(expr: Extract<IrExpr, { kind: "bin" }>): string {
    const left = this.emitExpr(expr.left);
    const right = this.emitExpr(expr.right);
    return this.emitBinaryValues(expr, left, right);
  }

  private emitBinaryValues(expr: Extract<IrExpr, { kind: "bin" }>, left: string, right: string): string {
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

  private emitToStringValue(type: IrType, operand: string, loc: SrcLoc): string {
    if (type.kind === "f64") return `runtime::number_to_string(${operand})`;
    if (type.kind === "bool") return `runtime::bool_to_string(${operand})`;
    if (type.kind === "caught") {
      const helper = this.errorClassRoots().length === 0 ? "runtime::caught_to_string" : "sc_caught_to_string";
      return `${helper}(&(${operand}))`;
    }
    if (type.kind === "union") {
      const union = this.union(type.unionId, loc);
      const name = this.unionName(union.id);
      const arms = union.arms.map((arm, tag) => {
        const variant = `${name}::${this.unionVariant(tag)}`;
        if (arm.kind === "undefinedT") return `${variant} => runtime::string("undefined")`;
        if (arm.kind === "nullT") return `${variant} => runtime::string("null")`;
        if (arm.kind === "string") return `${variant}(value) => value`;
        if (arm.kind === "f64") return `${variant}(value) => runtime::number_to_string(value)`;
        if (arm.kind === "bool") return `${variant}(value) => runtime::bool_to_string(value)`;
        this.unsupported(`toString union arm '${arm.kind}'`, loc);
      }).join(", ");
      return `match ${operand} { ${arms} }`;
    }
    this.unsupported(`toString from '${type.kind}'`, loc);
  }

  private emitPromiseRaceValue(from: IrType, to: IrType, value: string, loc: SrcLoc): string {
    if (typeKey(from) === typeKey(to)) return value;
    if (to.kind !== "union") this.unsupported("Promise.race adapter to a non-union", loc);
    const target = this.union(to.unionId, loc);
    const targetTag = (type: IrType): number => {
      const tag = target.arms.findIndex((arm) => typeKey(arm) === typeKey(type));
      if (tag < 0) this.unsupported(`Promise.race result union missing '${typeKey(type)}'`, loc);
      return tag;
    };
    const targetName = this.unionName(target.id);
    if (from.kind !== "union") {
      const tag = targetTag(from);
      const variant = `${targetName}::${this.unionVariant(tag)}`;
      return this.isUnit(from) ? `{ let _ = ${value}; ${variant} }` : `${variant}(${value})`;
    }
    const source = this.union(from.unionId, loc);
    const sourceName = this.unionName(source.id);
    const arms = source.arms.map((arm, tag) => {
      const sourceVariant = `${sourceName}::${this.unionVariant(tag)}`;
      const targetVariant = `${targetName}::${this.unionVariant(targetTag(arm))}`;
      return this.isUnit(arm)
        ? `${sourceVariant} => ${targetVariant}`
        : `${sourceVariant}(payload) => ${targetVariant}(payload)`;
    }).join(", ");
    return `match ${value} { ${arms} }`;
  }

  private displayExpr(expr: IrExpr): string {
    return this.displayValue(this.emitExpr(expr), expr.type, expr.loc);
  }

  private displayValue(value: string, type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64": return `runtime::display_number(${value})`;
      case "bool": return `runtime::display_bool(${value})`;
      case "string": return `runtime::display_string(&(${value}))`;
      default: this.unsupported(`console display type '${type.kind}'`, loc);
    }
  }

  private truthiness(value: string, type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "bool": return value;
      case "f64": return `(${value} != 0.0 && !${value}.is_nan())`;
      case "string": return `!${value}.is_empty()`;
      case "array": return "true";
      case "bytes": return "true";
      case "map": return "true";
      case "set": return "true";
      case "stats": return "true";
      case "spawnRes": return "true";
      case "record": return "true";
      case "object": return "true";
      case "func": return "true";
      case "promise": return "true";
      case "classval": return "true";
      case "union": {
        const union = this.union(type.unionId, loc);
        const name = this.unionName(union.id);
        const arms = union.arms.map((arm, tag) => {
          const variant = `${name}::${this.unionVariant(tag)}`;
          if (this.isUnit(arm)) return `${variant} => false`;
          if (arm.kind === "bool") return `${variant}(inner) => *inner`;
          if (arm.kind === "f64") return `${variant}(inner) => *inner != 0.0 && !inner.is_nan()`;
          if (arm.kind === "string") return `${variant}(inner) => !inner.is_empty()`;
          if (arm.kind === "classval") return `${variant}(inner) => *inner != 0`;
          if (arm.kind === "union") this.unsupported("nested union truthiness", loc);
          return `${variant}(..) => true`;
        }).join(", ");
        return `match &${value} { ${arms} }`;
      }
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
      if (type.kind === "f64" || type.kind === "bool" || type.kind === "classval") return `${name}.with(Cell::get)`;
      this.unsupported(`global read type '${type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (this.localIsBoxed(local)) {
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
      if (global.type.kind === "f64" || global.type.kind === "bool" || global.type.kind === "classval") return `${name}.with(|slot| slot.set(${value}));`;
      this.unsupported(`global assignment type '${global.type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (this.localIsBoxed(local)) return `runtime::cell_set(&${mangleLocal(id)}, ${value});`;
    return `${mangleLocal(id)} = ${value};`;
  }

  private local(id: string, loc: SrcLoc) {
    const local = this.currentFunction?.locals.find((candidate) => candidate.id === id);
    if (local === undefined) this.unsupported(`unknown local '${id}'`, loc);
    return local;
  }

  private localIsBoxed(local: IrFunction["locals"][number]): boolean {
    return local.boxed === true || this.currentFunction?.async === true;
  }

  private crossesCompletionBoundary(target: { id: number }): boolean {
    const boundary = this.completionLoopBoundaries.at(-1);
    if (boundary === undefined) return false;
    const index = this.loopTargets.findIndex((candidate) => candidate.id === target.id);
    return index >= 0 && index < boundary;
  }

  private rustBytesElement(elem: "u8" | "u32" | "i32" | "f32"): string {
    return elem;
  }

  private rustType(type: IrType, loc?: SrcLoc): string {
    switch (type.kind) {
      case "void": return "()";
      case "f64": return "f64";
      case "bool": return "bool";
      case "string": return "runtime::JsString";
      case "classval": {
        this.classMetaOf(type.className, loc);
        return "usize";
      }
      case "array": return `runtime::JsArray<${this.rustType(type.elem, loc)}>`;
      case "bytes": return `runtime::JsBytes<${this.rustBytesElement(type.elem)}>`;
      case "stats": return "runtime::JsStats";
      case "spawnRes": return "runtime::JsSpawnResult";
      case "map": return `runtime::JsMap<${this.rustType(type.key, loc)}, ${this.rustType(type.value, loc)}>`;
      case "set": return `runtime::JsSet<${this.rustType(type.elem, loc)}>`;
      case "record": {
        const shape = this.records.get(type.shapeId);
        if (shape === undefined) this.unsupported(`unknown record type '${type.shapeId}'`, loc);
        if (shape.indexValue !== undefined) this.unsupported(`indexed record value '${type.shapeId}'`, loc);
        return `runtime::Gc<${mangleRecordStruct(type.shapeId)}>`;
      }
      case "object": {
        if (RUNTIME_ERROR_CLASSES.has(type.className)) {
          return this.errorClassRoots().length === 0 ? "runtime::JsError" : this.errorValueName();
        }
        if (!this.classes.has(type.className)) this.unsupported(`object type '${type.className}'`, loc);
        return `runtime::Gc<${this.classStructName(type.className, loc)}>`;
      }
      case "union": {
        if (!this.unions.has(type.unionId)) this.unsupported(`unknown union type '${type.unionId}'`, loc);
        return this.unionName(type.unionId);
      }
      case "func": {
        const shape = this.closureShapeForType(type, loc);
        return `runtime::Gc<${this.closureName(shape)}>`;
      }
      case "promise": return `runtime::JsPromise<${this.rustType(type.inner, loc)}>`;
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
      case "bytes": return `runtime::bytes_empty::<${this.rustBytesElement(type.elem)}>()`;
      case "map": return "runtime::map_new()";
      case "set": return "runtime::set_new()";
      case "classval": return "0";
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
    return this.emitArrayIntrinsicValues(
      expr,
      this.emitExpr(expr.receiver),
      expr.args.map((arg) => this.emitExpr(arg)),
    );
  }

  private emitArrayGetValues(
    expr: Extract<IrExpr, { kind: "arrayGet" }>,
    array: string,
    index: string,
  ): string {
    if (expr.arr.type.kind !== "array") this.unsupported("async arrayGet on a non-array", expr.loc);
    return `runtime::array_get(&(${array}), ${index})`;
  }

  private emitArrayIntrinsicValues(
    expr: Extract<IrExpr, { kind: "arrIntrinsic" }>,
    receiverExpr: string,
    argExprs: readonly string[],
  ): string {
    if (expr.receiver.type.kind !== "array") this.unsupported("array intrinsic on a non-array", expr.loc);
    const receiver = `sc_rt_${this.temporary++}`;
    switch (expr.method) {
      case "length":
        return `runtime::array_len(&(${receiverExpr}))`;
      case "pop":
        return `runtime::array_pop(&(${receiverExpr}))`;
      case "indexOf":
      case "includes": {
        const needleExpr = argExprs[0];
        if (needleExpr === undefined) this.unsupported(`array ${expr.method} without a needle`, expr.loc);
        const needle = `sc_rt_${this.temporary++}`;
        const equality = this.arrayElementEquality("left", "right", expr.receiver.type.elem, expr.method === "includes", expr.loc);
        const helper = expr.method === "indexOf" ? "array_index_of_by" : "array_includes_by";
        return `{ let ${receiver} = ${receiverExpr}; let ${needle} = ${needleExpr}; runtime::${helper}(&${receiver}, &${needle}, |left, right| ${equality}) }`;
      }
      case "push": {
        const values = argExprs.map(() => `sc_rt_${this.temporary++}`);
        const bindings = argExprs.map((arg, index) => `let ${values[index]} = ${arg};`).join(" ");
        const pushes = values.map((value) => `runtime::array_push(&${receiver}, ${value});`).join(" ");
        return `{ let ${receiver} = ${receiverExpr}; ${bindings} ${pushes} runtime::array_len(&${receiver}) }`;
      }
      case "pushSpread": {
        const first = argExprs[0];
        if (first === undefined) this.unsupported("array pushSpread without a source", expr.loc);
        const source = `sc_rt_${this.temporary++}`;
        return `{ let ${receiver} = ${receiverExpr}; let ${source} = ${first}; runtime::array_extend(&${receiver}, &${source}) }`;
      }
      case "join": {
        const separator = argExprs[0];
        if (separator === undefined) this.unsupported("array join without a separator", expr.loc);
        const elem = expr.receiver.type.elem;
        if (elem.kind !== "f64" && elem.kind !== "bool" && elem.kind !== "string") {
          this.unsupported(`array join element '${elem.kind}'`, expr.loc);
        }
        return `runtime::array_join(&(${receiverExpr}), &(${separator}))`;
      }
      default:
        this.unsupported(`array intrinsic '${expr.method}'`, expr.loc);
    }
  }

  private emitMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "map") this.unsupported("map intrinsic on a non-map", expr.loc);
    const type = expr.receiver.type;
    const receiver = `sc_rt_${this.temporary++}`;
    const receiverBinding = `let ${receiver} = ${this.emitExpr(expr.receiver)};`;
    if (expr.method === "size") return `{ ${receiverBinding} runtime::map_size(&${receiver}) }`;
    if (expr.method === "clear") return `{ ${receiverBinding} runtime::map_clear(&${receiver}) }`;
    if (expr.method === "iterCount") return `{ ${receiverBinding} runtime::map_iter_count(&${receiver}) }`;
    if (expr.method === "iterEnter") return `{ ${receiverBinding} runtime::map_iter_enter(&${receiver}) }`;
    if (expr.method === "iterExit") return `{ ${receiverBinding} runtime::map_iter_exit(&${receiver}) }`;
    if (expr.method === "iterLive" || expr.method === "iterKey" || expr.method === "iterValue") {
      const indexExpr = expr.args[0];
      if (indexExpr === undefined) this.unsupported(`map ${expr.method} without an index`, expr.loc);
      const index = `sc_rt_${this.temporary++}`;
      const helper = expr.method === "iterLive"
        ? "map_iter_live"
        : expr.method === "iterKey" ? "map_iter_key" : "map_iter_value";
      return `{ ${receiverBinding} let ${index} = ${this.emitExpr(indexExpr)}; runtime::${helper}(&${receiver}, ${index}) }`;
    }
    const keyExpr = expr.args[0];
    if (keyExpr === undefined) this.unsupported(`map ${expr.method} without a key`, expr.loc);
    const key = `sc_rt_${this.temporary++}`;
    const equality = this.mapKeyEquality("left", "right", type.key, expr.loc);
    const bindings = `${receiverBinding} let ${key} = ${this.emitExpr(keyExpr)};`;
    switch (expr.method) {
      case "set": {
        const valueExpr = expr.args[1];
        if (valueExpr === undefined) this.unsupported("map set without a value", expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        return `{ ${bindings} let ${value} = ${this.emitExpr(valueExpr)}; runtime::map_set_by(&${receiver}, ${this.mapStoredKey(key, type.key)}, ${value}, |left, right| ${equality}) }`;
      }
      case "get": {
        if (expr.type.kind !== "union") this.unsupported("map get without an optional result union", expr.loc);
        const union = this.union(expr.type.unionId, expr.loc);
        const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
        if (undefinedTag < 0) this.unsupported("map get result union shape", expr.loc);
        const name = this.unionName(union.id);
        let present: string;
        if (type.value.kind === "union") {
          if (type.value.unionId === union.id) {
            present = "value";
          } else {
            const stored = this.union(type.value.unionId, expr.loc);
            const arms = stored.arms.map((arm, tag) => {
              const resultTag = union.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
              if (resultTag < 0) this.unsupported("map get union retag", expr.loc);
              const from = `${this.unionName(stored.id)}::${this.unionVariant(tag)}`;
              const to = `${name}::${this.unionVariant(resultTag)}`;
              return this.isUnit(arm) ? `${from} => ${to}` : `${from}(payload) => ${to}(payload)`;
            }).join(", ");
            present = `match value { ${arms} }`;
          }
        } else {
          const valueTag = union.arms.findIndex((arm) => typeKey(arm) === typeKey(type.value));
          if (valueTag < 0) this.unsupported("map get result union shape", expr.loc);
          present = `${name}::${this.unionVariant(valueTag)}(value)`;
        }
        return `{ ${bindings} match runtime::map_get_by(&${receiver}, &${key}, |left, right| ${equality}) { Some(value) => ${present}, None => ${name}::${this.unionVariant(undefinedTag)}, } }`;
      }
      case "has":
        return `{ ${bindings} runtime::map_has_by(&${receiver}, &${key}, |left, right| ${equality}) }`;
      case "delete":
        return `{ ${bindings} runtime::map_delete_by(&${receiver}, &${key}, |left, right| ${equality}) }`;
      default:
        this.unsupported(`map intrinsic '${expr.method}'`, expr.loc);
    }
  }

  private emitMapIntrinsicValues(
    expr: Extract<IrExpr, { kind: "mapIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    if (expr.receiver.type.kind !== "map") this.unsupported("async map intrinsic on a non-map", expr.loc);
    if (expr.method !== "set" || args.length !== 2 || args[0] === undefined || args[1] === undefined) {
      this.unsupported(`async map intrinsic '${expr.method}'`, expr.loc);
    }
    const equality = this.mapKeyEquality("left", "right", expr.receiver.type.key, expr.loc);
    return `runtime::map_set_by(&(${receiver}), ${this.mapStoredKey(args[0], expr.receiver.type.key)}, ${args[1]}, |left, right| ${equality})`;
  }

  private emitSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "set") this.unsupported("set intrinsic on a non-set", expr.loc);
    const type = expr.receiver.type;
    const receiver = `sc_rt_${this.temporary++}`;
    const receiverBinding = `let ${receiver} = ${this.emitExpr(expr.receiver)};`;
    if (expr.method === "size") return `{ ${receiverBinding} runtime::map_size(&${receiver}) }`;
    if (expr.method === "clear") return `{ ${receiverBinding} runtime::map_clear(&${receiver}) }`;
    if (expr.method === "iterCount") return `{ ${receiverBinding} runtime::map_iter_count(&${receiver}) }`;
    if (expr.method === "iterEnter") return `{ ${receiverBinding} runtime::map_iter_enter(&${receiver}) }`;
    if (expr.method === "iterExit") return `{ ${receiverBinding} runtime::map_iter_exit(&${receiver}) }`;
    if (expr.method === "iterLive" || expr.method === "iterKey") {
      const indexExpr = expr.args[0];
      if (indexExpr === undefined) this.unsupported(`set ${expr.method} without an index`, expr.loc);
      const index = `sc_rt_${this.temporary++}`;
      const helper = expr.method === "iterLive" ? "map_iter_live" : "map_iter_key";
      return `{ ${receiverBinding} let ${index} = ${this.emitExpr(indexExpr)}; runtime::${helper}(&${receiver}, ${index}) }`;
    }
    const valueExpr = expr.args[0];
    if (valueExpr === undefined) this.unsupported(`set ${expr.method} without a value`, expr.loc);
    const value = `sc_rt_${this.temporary++}`;
    const equality = this.mapKeyEquality("left", "right", type.elem, expr.loc);
    const bindings = `${receiverBinding} let ${value} = ${this.emitExpr(valueExpr)};`;
    switch (expr.method) {
      case "add":
        return `{ ${bindings} runtime::set_add_by(&${receiver}, ${this.mapStoredKey(value, type.elem)}, |left, right| ${equality}) }`;
      case "has":
        return `{ ${bindings} runtime::set_has_by(&${receiver}, &${value}, |left, right| ${equality}) }`;
      case "delete":
        return `{ ${bindings} runtime::set_delete_by(&${receiver}, &${value}, |left, right| ${equality}) }`;
      default:
        this.unsupported(`set intrinsic '${expr.method}'`, expr.loc);
    }
  }

  private needsClone(type: IrType): boolean {
    return type.kind === "string" || type.kind === "union" || type.kind === "caught" || this.isTracedHandle(type);
  }

  private arrayElementEquality(left: string, right: string, type: IrType, sameValueZero: boolean, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64":
        return sameValueZero
          ? `(*${left} == *${right} || (${left}.is_nan() && ${right}.is_nan()))`
          : `*${left} == *${right}`;
      case "bool":
      case "classval":
        return `${left} == ${right}`;
      case "string":
        return `${left}.as_ref() == ${right}.as_ref()`;
      case "array":
      case "record":
      case "func":
        return `${left}.ptr_eq(${right})`;
      case "object":
        if (this.classes.has(type.className)) return `${left}.ptr_eq(${right})`;
        this.unsupported(`array identity for runtime object '${type.className}'`, loc);
      default:
        this.unsupported(`array ${sameValueZero ? "includes" : "indexOf"} element '${type.kind}'`, loc);
    }
  }

  private mapKeyEquality(left: string, right: string, type: IrType, loc: SrcLoc): string {
    if (type.kind === "f64") return `(*${left} == *${right} || (${left}.is_nan() && ${right}.is_nan()))`;
    if (type.kind === "string") return `${left}.as_ref() == ${right}.as_ref()`;
    this.unsupported(`map key '${type.kind}'`, loc);
  }

  private mapStoredKey(value: string, type: IrType): string {
    return type.kind === "f64" ? `if ${value} == 0.0 { 0.0 } else { ${value} }` : value;
  }

  private isTracedHandle(type: IrType): boolean {
    return type.kind === "array" || type.kind === "bytes" || type.kind === "map" || type.kind === "set" || type.kind === "stats" || type.kind === "spawnRes" || type.kind === "record" || type.kind === "promise" ||
      (type.kind === "object" && (this.classes.has(type.className) ||
        (RUNTIME_ERROR_CLASSES.has(type.className) && this.errorClassRoots().length > 0))) || type.kind === "func";
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

  private isRustJsonCompatible(type: IrType, visiting = new Set<string>()): boolean {
    switch (type.kind) {
      case "f64":
      case "bool":
      case "string":
      case "undefinedT":
      case "nullT":
        return true;
      case "array":
        return this.isRustJsonCompatible(type.elem, visiting);
      case "record": {
        const key = `record:${type.shapeId}`;
        if (visiting.has(key)) return true;
        const shape = this.records.get(type.shapeId);
        if (shape === undefined || shape.indexValue !== undefined) return false;
        const next = new Set(visiting).add(key);
        return shape.fields.every((field) => this.isRustJsonCompatible(field.type, next));
      }
      case "union": {
        const key = `union:${type.unionId}`;
        if (visiting.has(key)) return true;
        const union = this.unions.get(type.unionId);
        if (union === undefined) return false;
        const next = new Set(visiting).add(key);
        return union.arms.every((arm) => this.isRustJsonCompatible(arm, next));
      }
      default:
        return false;
    }
  }

  private ensureUnionArm(type: IrType): void {
    switch (type.kind) {
      case "f64":
      case "bool":
      case "string":
      case "array":
      case "record":
      case "object":
      case "classval":
      case "func":
      case "promise":
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

  private classDef(name: string, loc?: SrcLoc): IrClassDef {
    const cls = this.classes.get(name);
    if (cls === undefined) this.unsupported(`class '${name}'`, loc);
    return cls;
  }

  private stripCasts(expr: IrExpr): IrExpr {
    let value = expr;
    while (value.kind === "upcast" || value.kind === "downcast") value = value.value;
    return value;
  }

  private runtimeErrorAncestor(name: string): string | null {
    const seen = new Set<string>();
    let cls = this.classes.get(name);
    while (cls?.base !== undefined && !seen.has(cls.name)) {
      seen.add(cls.name);
      if (RUNTIME_ERROR_CLASSES.has(cls.base)) return cls.base;
      cls = this.classes.get(cls.base);
    }
    return null;
  }

  private errorClassRoots(): RustClassMeta[] {
    return [...this.classMeta.values()].filter((meta) =>
      meta === meta.root && this.runtimeErrorAncestor(meta.def.name) !== null
    );
  }

  private errorValueName(): string {
    return "sc_error_value";
  }

  private errorValueVariant(meta: RustClassMeta): string {
    return `User${meta.root.pre}`;
  }

  private runtimeErrorClassNames(name: string): string[] {
    const ancestor = this.runtimeErrorAncestor(name);
    if (ancestor === null) return [];
    const names: string[] = [];
    let current: string | null = ancestor;
    while (current !== null) {
      const error = RUNTIME_ERROR_CLASSES.get(current);
      if (error === undefined) break;
      names.push(error.lib);
      current = error.base;
    }
    return names;
  }

  private runtimeErrorIsA(source: string, target: string): boolean {
    let current: string | null = source;
    while (current !== null) {
      if (current === target) return true;
      current = RUNTIME_ERROR_CLASSES.get(current)?.base ?? null;
    }
    return false;
  }

  private classMetaOf(name: string, loc?: SrcLoc): RustClassMeta {
    const meta = this.classMeta.get(name);
    if (meta === undefined) this.unsupported(`class '${name}'`, loc);
    return meta;
  }

  private classStructName(name: string, loc?: SrcLoc): string {
    const meta = this.classMetaOf(name, loc);
    return mangleClassStruct(meta.hierarchy ? meta.root.def.name : name);
  }

  private hierarchyFields(root: RustClassMeta): { owner: RustClassMeta; field: IrClassDef["fields"][number] }[] {
    const fields: { owner: RustClassMeta; field: IrClassDef["fields"][number] }[] = [];
    const visit = (meta: RustClassMeta): void => {
      const inherited = meta.base?.def.fields.length ?? 0;
      for (const field of meta.def.fields.slice(inherited)) fields.push({ owner: meta, field });
      for (const child of meta.children) visit(child);
    };
    visit(root);
    return fields;
  }

  private classSubtree(meta: RustClassMeta): RustClassMeta[] {
    return [...this.classMeta.values()].filter((candidate) =>
      candidate.root === meta.root && meta.pre <= candidate.pre && candidate.pre <= meta.post
    );
  }

  private classAllocation(meta: RustClassMeta, args: readonly string[], loc: SrcLoc): string {
    const constructor = this.functions.get(`%${meta.def.name}.constructor`);
    if (constructor === undefined) this.unsupported(`missing constructor for '${meta.def.name}'`, loc);
    const object = `sc_rt_${this.temporary++}`;
    const shapeFields = meta.hierarchy
      ? this.hierarchyFields(meta.root)
      : meta.def.fields.map((field) => ({ owner: meta, field }));
    const fields = shapeFields.map(({ owner, field }) => {
      const value = this.isEdgeValue(field.type) ? "None" : this.defaultValue(field.type, meta.def.loc);
      return `${this.classFieldStorageName(owner, field.name)}: ${value}`;
    }).join(", ");
    const classTag = meta.hierarchy ? `sc_class_pre: ${meta.pre}, ` : "";
    return `{ let ${object} = runtime::Gc::new(${this.classStructName(meta.def.name, loc)} { ${classTag}${fields} }); ${mangleFunction(constructor.name)}(${[`${object}.clone()`, ...args].join(", ")}); ${object} }`;
  }

  private classFieldName(className: string, fieldName: string, loc?: SrcLoc): string {
    let owner = this.classMetaOf(className, loc);
    const index = owner.def.fields.findIndex((field) => field.name === fieldName);
    if (index < 0) this.unsupported(`unknown class field '${className}.${fieldName}'`, loc);
    while (owner.base !== null && index < owner.base.def.fields.length) owner = owner.base;
    return this.classFieldStorageName(owner, fieldName);
  }

  private classFieldStorageName(owner: RustClassMeta, fieldName: string): string {
    return owner.hierarchy ? `sc_hf_${owner.pre}_${mangleField(fieldName)}` : mangleField(fieldName);
  }

  private virtualImplementation(meta: RustClassMeta, slot: RustVtSlot): IrFunction {
    for (let current: RustClassMeta | null = meta; current !== null; current = current.base) {
      if (current.def.methods?.includes(slot.method) && !current.def.abstractMethods?.includes(slot.method)) {
        const fn = this.functions.get(`%${current.def.name}.${slot.method}`);
        if (fn === undefined) this.unsupported(`missing virtual implementation '${current.def.name}.${slot.method}'`, current.def.loc);
        return fn;
      }
    }
    this.unsupported(`missing virtual implementation '${meta.def.name}.${slot.method}'`, meta.def.loc);
  }

  private closureName(shape: RustClosureShape): string {
    return `sc_closure_${shape.index}`;
  }

  private promiseRejectorVariant(type: IrFuncType, promiseType: IrType, loc?: SrcLoc): string {
    const promiseTypes = this.promiseRejectorTypes.get(typeKey(type));
    const index = promiseTypes?.findIndex((candidate) => typeKey(candidate) === typeKey(promiseType)) ?? -1;
    if (index < 0) this.unsupported(`Promise rejector for '${typeKey(promiseType)}'`, loc);
    return `PromiseRejector${index}`;
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
