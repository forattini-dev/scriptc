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
import { emitRustStatements } from "./statements.js";
import { RustContainerExpressionEmitter } from "./container-expressions.js";
import { RustDynamicEmitter } from "./dynamic.js";
import { RustAsyncControlEmitter } from "./async-control.js";
import type { RustAsyncHandlers } from "./async-control.js";
import { RustAsyncValueEmitter } from "./async-values.js";
import { RustExpressionEmitter } from "./expressions.js";
import type { IrFuncType, RustClassMeta, RustClosureShape, RustVtSlot } from "./model.js";
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

type IrAwaitExpr = Extract<IrExpr, { kind: "awaitExpr" | "awaitUnionExpr" }>;

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
  private readonly dynBoxedFunctionShapes = new Set<string>();
  private readonly dynAdapterShapes = new Set<string>();
  private readonly promiseResolverTypes = new Map<string, IrType>();
  private readonly promiseRejectorTypes = new Map<string, IrType[]>();
  private readonly internedClosureTargets = new Set<string>();
  private readonly chainValues = new Map<string, string>();
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
  private usesDyn = false;
  private readonly containerExpressions = new RustContainerExpressionEmitter({
    nextTemporary: () => `sc_rt_${this.temporary++}`,
    emitExpr: (expr) => this.emitExpr(expr),
    arrayElementEquality: (left, right, type, sameValueZero, loc) =>
      this.arrayElementEquality(left, right, type, sameValueZero, loc),
    mapKeyEquality: (left, right, type, loc) => this.mapKeyEquality(left, right, type, loc),
    mapStoredKey: (value, type) => this.mapStoredKey(value, type),
    rustBytesElement: (elem) => this.rustBytesElement(elem),
    isUnit: (type) => this.isUnit(type),
    union: (id, loc) => this.union(id, loc),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
  });
  private readonly dynamicEmitter = new RustDynamicEmitter({
    usesDyn: () => this.usesDyn,
    closureShapes: this.closureShapes,
    dynAdapterShapes: this.dynAdapterShapes,
    dynBoxedFunctionShapes: this.dynBoxedFunctionShapes,
    records: this.records,
    unions: this.unions,
    module: () => this.mod,
    line: (value) => this.line(value),
    pushIndent: () => { this.indent += 1; },
    popIndent: () => { this.indent -= 1; },
    nextTemporary: () => `sc_rt_${this.temporary++}`,
    closureName: (shape) => this.closureName(shape),
    closureShapeForType: (type, loc) => this.closureShapeForType(type, loc),
    dynFunctionCheckName: (shape) => this.dynFunctionCheckName(shape),
    dynFunctionVariant: (shape) => this.dynFunctionVariant(shape),
    dynTypeName: () => this.dynTypeName(),
    emitClosureDispatch: (callee, type, args, loc) => this.emitClosureDispatch(callee, type, args, loc),
    errorClassRoots: () => this.errorClassRoots(),
    isEdgeValue: (type) => this.isEdgeValue(type),
    isRustJsonCompatible: (type, visiting) => this.isRustJsonCompatible(type, visiting),
    isUnit: (type) => this.isUnit(type),
    needsClone: (type) => this.needsClone(type),
    rustString: (value) => this.rustString(value),
    rustType: (type, loc) => this.rustType(type, loc),
    union: (id, loc) => this.union(id, loc),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
  });
  private readonly asyncControlEmitter = new RustAsyncControlEmitter({
    records: this.records,
    line: (value) => this.line(value),
    pushIndent: () => { this.indent += 1; },
    popIndent: () => { this.indent -= 1; },
    nextName: (prefix) => `${prefix}_${this.temporary++}`,
    currentAsyncResult: () => this.currentAsyncResult,
    currentFunction: () => this.currentFunction,
    currentAsyncLocals: () => this.currentAsyncLocals,
    setCurrentAsyncLocals: (locals) => { this.currentAsyncLocals = locals; },
    adjustAsyncProtectedReturnDepth: (delta) => { this.asyncProtectedReturnDepth += delta; },
    emitExpr: (expr) => this.emitExpr(expr),
    emitStatement: (statement) => this.emitStatement(statement),
    emitAssignment: (id, value, loc) => this.emitAssignment(id, value, loc),
    emitAsyncValue: (expr, consume) => this.emitAsyncValue(expr, consume),
    emitAsyncContinuation: (dependencyExpr, consume, remaining, onComplete) =>
      this.asyncValueEmitter.emitAsyncContinuation(dependencyExpr, consume, remaining, onComplete),
    emitAsyncProtectedValues: (exprs, exitLocals, handlers, consume, index, values) =>
      this.emitAsyncProtectedValues(exprs, exitLocals, handlers, consume, index, values),
    emitAsyncProtectedRecordCloneOverrides: (expr, clone, exitLocals, handlers, consume, index) =>
      this.emitAsyncProtectedRecordCloneOverrides(expr, clone, exitLocals, handlers, consume, index),
    emitAsyncConsole: (expr, remaining, index, values, onComplete) =>
      this.emitAsyncConsole(expr, remaining, index, values, onComplete),
    emitBinaryValues: (expr, left, right) => this.emitBinaryValues(expr, left, right),
    emitArrayGetValues: (expr, array, index) => this.emitArrayGetValues(expr, array, index),
    emitBytesNewValue: (expr, source) => this.emitBytesNewValue(expr, source),
    emitArrayIntrinsicValues: (expr, receiver, args) => this.emitArrayIntrinsicValues(expr, receiver, args),
    emitMapIntrinsicValues: (expr, receiver, args) => this.emitMapIntrinsicValues(expr, receiver, args),
    emitRecordCloneInitial: (expr, source) => this.emitRecordCloneInitial(expr, source),
    emitRecordCloneOverride: (expr, clone, name, value) =>
      this.emitRecordCloneOverride(expr, clone, name, value),
    emitToStringValue: (type, operand, loc) => this.emitToStringValue(type, operand, loc),
    displayValue: (value, type, loc) => this.displayValue(value, type, loc),
    local: (id, loc) => this.local(id, loc),
    needsClone: (type) => this.needsClone(type),
    isEdgeValue: (type) => this.isEdgeValue(type),
    isUnit: (type) => this.isUnit(type),
    rustString: (value) => this.rustString(value),
    rustType: (type, loc) => this.rustType(type, loc),
    union: (id, loc) => this.union(id, loc),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
  });
  private readonly asyncValueEmitter = new RustAsyncValueEmitter({
    records: this.records,
    line: (value) => this.line(value),
    pushIndent: () => { this.indent += 1; },
    popIndent: () => { this.indent -= 1; },
    nextName: (prefix) => `${prefix}_${this.temporary++}`,
    currentAsyncResult: () => this.currentAsyncResult,
    currentFunction: () => this.currentFunction,
    containsAsyncSuspension: (value) => this.containsAsyncSuspension(value),
    awaitExpression: (expr) => this.awaitExpression(expr),
    emitAwaitDependency: (expr) => this.emitAwaitDependency(expr),
    emitAsyncProtectedValue: (expr, exitLocals, handlers, consume) =>
      this.emitAsyncProtectedValue(expr, exitLocals, handlers, consume),
    emitAsyncStatements: (statements, onComplete) => this.emitAsyncStatements(statements, onComplete),
    emitExpr: (expr) => this.emitExpr(expr),
    emitBinaryValues: (expr, left, right) => this.emitBinaryValues(expr, left, right),
    emitArrayGetValues: (expr, array, index) => this.emitArrayGetValues(expr, array, index),
    emitBytesNewValue: (expr, source) => this.emitBytesNewValue(expr, source),
    emitArrayIntrinsicValues: (expr, receiver, args) => this.emitArrayIntrinsicValues(expr, receiver, args),
    emitMapIntrinsicValues: (expr, receiver, args) => this.emitMapIntrinsicValues(expr, receiver, args),
    emitToStringValue: (type, operand, loc) => this.emitToStringValue(type, operand, loc),
    displayValue: (value, type, loc) => this.displayValue(value, type, loc),
    needsClone: (type) => this.needsClone(type),
    isEdgeValue: (type) => this.isEdgeValue(type),
    isUnit: (type) => this.isUnit(type),
    union: (id, loc) => this.union(id, loc),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
  });
  private readonly expressionEmitter = new RustExpressionEmitter({
    chainValues: this.chainValues,
    classMeta: this.classMeta,
    closureShapes: this.closureShapes,
    dynBoxedFunctionShapes: this.dynBoxedFunctionShapes,
    functions: this.functions,
    records: this.records,
    nextName: (prefix) => `${prefix}_${this.temporary++}`,
    currentFunction: () => this.currentFunction,
    emitSequence: (statements, emitResult) => {
      const start = this.lines.length;
      const previousIndent = this.indent;
      this.indent = 0;
      this.emitStatements(statements);
      const result = emitResult();
      const emittedStatements = this.lines.splice(start).join(" ");
      this.indent = previousIndent;
      return `{ ${emittedStatements} ${result} }`;
    },
    assignmentExpr: (id, value, loc) => this.assignmentExpr(id, value, loc),
    classAllocation: (meta, args, loc) => this.classAllocation(meta, args, loc),
    classDef: (name, loc) => this.classDef(name, loc),
    classFieldName: (className, fieldName, loc) => this.classFieldName(className, fieldName, loc),
    classFieldStorageName: (owner, fieldName) => this.classFieldStorageName(owner, fieldName),
    classMetaOf: (name, loc) => this.classMetaOf(name, loc),
    classStructName: (name, loc) => this.classStructName(name, loc),
    classSubtree: (meta) => this.classSubtree(meta),
    closureName: (shape) => this.closureName(shape),
    closureShapeForType: (type, loc) => this.closureShapeForType(type, loc),
    defaultValue: (type, loc) => this.defaultValue(type, loc),
    displayExpr: (expr) => this.displayExpr(expr),
    dynFunctionVariant: (shape) => this.dynFunctionVariant(shape),
    dynTypeName: () => this.dynTypeName(),
    emitArrayIntrinsic: (expr) => this.emitArrayIntrinsic(expr),
    emitBinary: (expr) => this.emitBinary(expr),
    emitBytesNewValue: (expr, source) => this.emitBytesNewValue(expr, source),
    emitCallValue: (expr) => this.emitCallValue(expr),
    emitClosure: (expr) => this.emitClosure(expr),
    emitClosureDispatch: (callee, type, args, loc) => this.emitClosureDispatch(callee, type, args, loc),
    emitDynCheckValue: (type, value, loc) => this.emitDynCheckValue(type, value, loc),
    emitDynFromValue: (type, value, loc, functionName) => this.emitDynFromValue(type, value, loc, functionName),
    emitFileHandleTransferPromise: (expr) => this.emitFileHandleTransferPromise(expr),
    emitFsRenameCallback: (expr) => this.emitFsRenameCallback(expr),
    emitMapIntrinsic: (expr) => this.emitMapIntrinsic(expr),
    emitPromiseFromSync: (args, operation) => this.emitPromiseFromSync(args, operation),
    emitPromiseRaceValue: (from, to, value, loc) => this.emitPromiseRaceValue(from, to, value, loc),
    emitRead: (id, type, loc) => this.emitRead(id, type, loc),
    emitRecordCloneInitial: (expr, source) => this.emitRecordCloneInitial(expr, source),
    emitRecordCloneOverride: (expr, clone, name, value) =>
      this.emitRecordCloneOverride(expr, clone, name, value),
    emitSetIntrinsic: (expr) => this.emitSetIntrinsic(expr),
    emitStatements: (statements) => this.emitStatements(statements),
    emitToStringValue: (type, operand, loc) => this.emitToStringValue(type, operand, loc),
    errorClassRoots: () => this.errorClassRoots(),
    errorValueName: () => this.errorValueName(),
    errorValueVariant: (meta) => this.errorValueVariant(meta),
    hierarchyFields: (root) => this.hierarchyFields(root),
    isEdgeValue: (type) => this.isEdgeValue(type),
    isRustJsonCompatible: (type, visiting) => this.isRustJsonCompatible(type, visiting),
    isUnit: (type) => this.isUnit(type),
    mapKeyEquality: (left, right, type, loc) => this.mapKeyEquality(left, right, type, loc),
    mapStoredKey: (value, type) => this.mapStoredKey(value, type),
    needsClone: (type) => this.needsClone(type),
    numberLiteral: (value) => this.numberLiteral(value),
    promiseRejectorVariant: (type, promiseType, loc) => this.promiseRejectorVariant(type, promiseType, loc),
    runtimeErrorAncestor: (name) => this.runtimeErrorAncestor(name),
    runtimeErrorIsA: (source, target) => this.runtimeErrorIsA(source, target),
    rustString: (value) => this.rustString(value),
    rustType: (type, loc) => this.rustType(type, loc),
    stripCasts: (expr) => this.stripCasts(expr),
    truthiness: (value, type, loc) => this.truthiness(value, type, loc),
    union: (id, loc) => this.union(id, loc),
    unionEqName: (id) => this.unionEqName(id),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
    virtualImplementation: (meta, slot) => this.virtualImplementation(meta, slot),
  });

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
    this.usesDyn = [...this.globals.values()].some((global) => global.type.kind === "dyn");
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
    this.emitDynamicDefinition();
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
    if (this.usesDyn) this.line("sc_dyn_error_cache_clear();");
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
      if (node.kind === "dynFrom") {
        this.usesDyn = true;
        const operand = node.value as { type?: IrType } | undefined;
        if (operand?.type?.kind === "func") {
          this.registerDynBoxedFunction(operand.type);
        }
      }
      if (node.kind === "dynCheck") {
        const operand = node.value as { kind?: string; fn?: string } | undefined;
        const jsonParse = operand?.kind === "libCall" && operand.fn === "json.parse";
        if (!jsonParse) {
          this.usesDyn = true;
          const target = node.type as IrType | undefined;
          if (target?.kind === "func") {
            this.registerDynAdapter(target);
          }
        }
      }
      const nodeType = node.type as IrType | undefined;
      if (nodeType?.kind === "dyn" || node.kind === "dynTest" || node.kind === "dynCall") this.usesDyn = true;
      if (node.kind === "closure") {
        const type = node.type as IrType | undefined;
        const fnName = node.fnName;
        if (type?.kind !== "func" || typeof fnName !== "string") {
          this.unsupported("malformed closure IR");
        }
        const target = this.functions.get(fnName);
        if (target === undefined) this.unsupported(`unknown closure target '${fnName}'`);
        const shape = this.ensureClosureShape(type);
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

  private ensureClosureShape(type: IrFuncType): RustClosureShape {
    const key = typeKey(type);
    let shape = this.closureShapes.get(key);
    if (shape === undefined) {
      shape = { index: this.closureShapes.size, type, targets: [] };
      this.closureShapes.set(key, shape);
    }
    return shape;
  }

  private registerDynBoxedFunction(type: IrFuncType): void {
    const shape = this.ensureClosureShape(type);
    const key = typeKey(shape.type);
    if (this.dynBoxedFunctionShapes.has(key)) return;
    this.dynBoxedFunctionShapes.add(key);
    for (const param of type.params) {
      if (param.kind === "func") this.registerDynAdapter(param);
    }
    if (type.ret.kind === "func") this.registerDynBoxedFunction(type.ret);
  }

  private registerDynAdapter(type: IrFuncType): void {
    const shape = this.ensureClosureShape(type);
    const key = typeKey(shape.type);
    if (this.dynAdapterShapes.has(key)) return;
    this.dynAdapterShapes.add(key);
    for (const param of type.params) {
      if (param.kind === "func") this.registerDynBoxedFunction(param);
    }
    if (type.ret.kind === "func") this.registerDynAdapter(type.ret);
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
      const dynAdapter = this.dynAdapterShapes.has(typeKey(shape.type));
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
      if (dynAdapter) this.line(`DynAdapter { value: Option<${this.dynTypeName()}> },`);
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${name} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      const capturing = shape.targets.filter((target) => (target.captures?.length ?? 0) > 0);
      if (capturing.length === 0 && resolverType === undefined && rejectorTypes.length === 0 && !dynAdapter) {
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
        if (dynAdapter) {
          this.line("Self::DynAdapter { value } => {");
          this.indent += 1;
          this.line("if let Some(edge) = value { runtime::Trace::trace(edge, tracer); }");
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
      if (capturing.length > 0 || resolverType !== undefined || rejectorTypes.length > 0 || dynAdapter) {
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
        if (dynAdapter) this.line("Self::DynAdapter { value } => *value = None,");
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

  private emitDynamicDefinition(): void {
    this.dynamicEmitter.emitDynamicDefinition();
  }

  private emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName = ""): string {
    return this.dynamicEmitter.emitDynFromValue(type, value, loc, functionName);
  }

  private emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string {
    return this.dynamicEmitter.emitDynCheckValue(type, value, loc);
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
        case "fileHandle":
        case "spawnRes":
        case "record":
        case "func":
        case "promise":
          comparison = "left.ptr_eq(right)";
          break;
        case "regex":
        case "symbol":
        case "url":
        case "searchParams":
          comparison = "std::rc::Rc::ptr_eq(left, right)";
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
        case "date":
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
        case "fileHandle":
        case "spawnRes":
        case "map":
        case "set":
        case "record":
        case "object":
        case "union":
        case "func":
        case "promise":
        case "regex":
        case "symbol":
        case "url":
        case "searchParams":
        case "dyn":
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
    return this.asyncControlEmitter.containsAsyncSuspension(value);
  }

  private awaitExpression(expr: IrExpr | null): IrAwaitExpr | null {
    return this.asyncControlEmitter.awaitExpression(expr);
  }

  private emitAwaitDependency(expr: IrAwaitExpr): string {
    return this.asyncControlEmitter.emitAwaitDependency(expr);
  }

  private emitAsyncStatements(
    statements: readonly IrStmt[],
    onComplete: (() => void) | null = null,
  ): void {
    this.asyncControlEmitter.emitAsyncStatements(statements, onComplete);
  }

  private emitAsyncProtectedValue(
    expr: IrExpr,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (value: string) => void,
  ): void {
    this.asyncControlEmitter.emitAsyncProtectedValue(expr, exitLocals, handlers, consume);
  }

  private emitAsyncValue(expr: IrExpr, consume: (value: string) => void): void {
    this.asyncValueEmitter.emitAsyncValue(expr, consume);
  }

  private emitRecordCloneInitial(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    source: string,
  ): string {
    return this.asyncValueEmitter.emitRecordCloneInitial(expr, source);
  }

  private emitRecordCloneOverride(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    clone: string,
    fieldName: string,
    value: string,
  ): string {
    return this.asyncValueEmitter.emitRecordCloneOverride(expr, clone, fieldName, value);
  }

  private emitAsyncProtectedRecordCloneOverrides(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    clone: string,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: () => void,
    index = 0,
  ): void {
    this.asyncValueEmitter.emitAsyncProtectedRecordCloneOverrides(
      expr,
      clone,
      exitLocals,
      handlers,
      consume,
      index,
    );
  }

  private emitAsyncProtectedValues(
    exprs: readonly IrExpr[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (values: string[]) => void,
    index = 0,
    values: string[] = [],
  ): void {
    this.asyncValueEmitter.emitAsyncProtectedValues(exprs, exitLocals, handlers, consume, index, values);
  }

  private emitAsyncConsole(
    expr: Extract<IrExpr, { kind: "intrinsic" }>,
    remaining: readonly IrStmt[],
    index = 0,
    values: { name: string; type: IrType; loc: SrcLoc }[] = [],
    onComplete: (() => void) | null = null,
  ): void {
    this.asyncValueEmitter.emitAsyncConsole(expr, remaining, index, values, onComplete);
  }

  private emitStatements(statements: readonly IrStmt[]): void {
    emitRustStatements(statements, {
      loopTargets: this.loopTargets,
      completionLoopBoundaries: this.completionLoopBoundaries,
      capturedReturnDepth: () => this.capturedReturnDepth,
      adjustCapturedReturnDepth: (delta) => { this.capturedReturnDepth += delta; },
      asyncProtectedReturnDepth: () => this.asyncProtectedReturnDepth,
      currentAsyncResult: () => this.currentAsyncResult,
      currentFunction: () => this.currentFunction,
      line: (value) => this.line(value),
      pushIndent: () => { this.indent += 1; },
      popIndent: () => { this.indent -= 1; },
      nextTemporary: () => `sc_rt_${this.temporary++}`,
      nextLabel: (prefix) => `${prefix}_${this.temporary++}`,
      nextLoopTargetId: () => this.nextLoopTargetId++,
      emitExpr: (expr) => this.emitExpr(expr),
      emitRead: (id, type, loc) => this.emitRead(id, type, loc),
      emitAssignment: (id, value, loc) => this.emitAssignment(id, value, loc),
      local: (id, loc) => this.local(id, loc),
      localIsBoxed: (local) => this.localIsBoxed(local),
      rustType: (type, loc) => this.rustType(type, loc),
      defaultValue: (type, loc) => this.defaultValue(type, loc),
      record: (shapeId) => this.records.get(shapeId),
      classDef: (name, loc) => this.classDef(name, loc),
      classFieldName: (className, fieldName, loc) => this.classFieldName(className, fieldName, loc),
      isEdgeValue: (type) => this.isEdgeValue(type),
      rustString: (value) => this.rustString(value),
      unsupported: (kind, loc) => this.unsupported(kind, loc),
    });
  }

  private emitStatement(statement: IrStmt): void {
    this.emitStatements([statement]);
  }

  private emitExpr(expr: IrExpr): string {
    return this.expressionEmitter.emitExpr(expr);
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
    if (this.dynAdapterShapes.has(typeKey(shape.type))) {
      const dynamicArgs = shape.type.params.map((param, index) => {
        const arg = args[index];
        if (arg === undefined) this.unsupported("dynamic adapter argument arity", loc);
        return this.emitDynFromValue(param, arg, loc);
      }).join(", ");
      const call = `sc_dyn_call(value.as_ref().expect("scriptc: cleared live dynamic function adapter"), &sc_dyn_args, "value")`;
      let result: string;
      if (shape.type.ret.kind === "void") {
        result = `{ let _ = ${call}; () }`;
      } else {
        result = this.emitDynCheckValue(shape.type.ret, call, loc);
      }
      arms.push(`${this.closureName(shape)}::DynAdapter { value } => { let sc_dyn_args = [${dynamicArgs}]; ${result} }`);
    }
    return `${callee}.with(|closure| match closure { ${arms.join(", ")} })`;
  }

  private emitBinary(expr: Extract<IrExpr, { kind: "bin" }>): string {
    const left = this.emitExpr(expr.left);
    const right = this.emitExpr(expr.right);
    return this.emitBinaryValues(expr, left, right);
  }

  private emitBinaryValues(expr: Extract<IrExpr, { kind: "bin" }>, left: string, right: string): string {
    if ((expr.left.type.kind === "regex" || expr.left.type.kind === "symbol" || expr.left.type.kind === "url" || expr.left.type.kind === "searchParams") &&
        (expr.op === "===" || expr.op === "!==")) {
      const compare = `std::rc::Rc::ptr_eq(&(${left}), &(${right}))`;
      return expr.op === "!==" ? `!(${compare})` : compare;
    }
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
    if (type.kind === "dyn") return `sc_dyn_to_string(&(${operand}))`;
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

  private emitPromiseFromSync(
    args: readonly IrExpr[],
    operation: (value: (index: number) => string) => string,
  ): string {
    const values = args.map(() => `sc_rt_${this.temporary++}`);
    const value = (index: number): string => {
      const result = values[index];
      if (result === undefined) this.unsupported(`missing synchronous promise argument ${index}`);
      return result;
    };
    const bindings = args.map((arg, index) => {
      if (arg.kind !== "seqExpr") return `let ${value(index)} = ${this.emitExpr(arg)};`;
      // A sequence may declare a hidden local whose value is deliberately
      // consumed by a later argument (FileHandle's optional length marker is
      // one example). Keep every argument left-to-right, but let those
      // declarations live in this shared expression block rather than an
      // argument-private Rust block.
      const start = this.lines.length;
      const previousIndent = this.indent;
      this.indent = 0;
      this.emitStatements(arg.stmts);
      const result = this.emitExpr(arg.result);
      const statements = this.lines.splice(start).join(" ");
      this.indent = previousIndent;
      return `${statements} let ${value(index)} = ${result};`;
    }).join(" ");
    return `{ ${bindings} runtime::promise_from_sync(move || ${operation(value)}) }`;
  }

  private emitFileHandleTransferPromise(expr: Extract<IrExpr, { kind: "libCall" }>): string {
    if (expr.type.kind !== "promise" || expr.type.inner.kind !== "record") {
      this.unsupported(`${expr.fn} result without a record promise`, expr.loc);
    }
    const recordType = expr.type.inner;
    const shape = this.records.get(recordType.shapeId);
    if (shape === undefined) this.unsupported(`unknown FileHandle result shape '${recordType.shapeId}'`, expr.loc);
    const countField = expr.fn === "fileHandle.read" ? "bytesRead" : "bytesWritten";
    const expectedArgs = expr.fn === "fileHandle.writeStr" ? 4 : 6;
    if (expr.args.length !== expectedArgs || expr.args[1] === undefined) {
      this.unsupported(`${expr.fn} argument shape`, expr.loc);
    }
    const fields = shape.fields.map((field) => {
      if (field.name === countField) return `${mangleField(field.name)}: sc_count`;
      if (field.name === "buffer") {
        return `${mangleField(field.name)}: ${this.isEdgeValue(field.type) ? "Some(sc_buffer)" : "sc_buffer"}`;
      }
      this.unsupported(`unexpected FileHandle result field '${field.name}'`, expr.loc);
    }).join(", ");
    return this.emitPromiseFromSync(expr.args, (value) => {
      const operation = expr.fn === "fileHandle.read"
        ? `runtime::file_handle_read(&${value(0)}, &${value(1)}, ${value(2)}, ${value(3)}, ${value(4)}, ${value(5)})`
        : expr.fn === "fileHandle.writeBytes"
          ? `runtime::file_handle_write_bytes(&${value(0)}, &${value(1)}, ${value(2)}, ${value(3)}, ${value(4)}, ${value(5)})`
          : `runtime::file_handle_write_str(&${value(0)}, &${value(1)}, ${value(2)}, &${value(3)})`;
      return `{ let sc_count = ${operation}; let sc_buffer = ${value(1)}; runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} }) }`;
    });
  }

  private emitFsRenameCallback(expr: Extract<IrExpr, { kind: "libCall" }>): string {
    const [fromExpr, toExpr, callbackExpr] = expr.args;
    if (fromExpr === undefined || toExpr === undefined || callbackExpr === undefined || expr.args.length !== 3) {
      this.unsupported("fs.rename callback argument shape", expr.loc);
    }
    if (callbackExpr.type.kind !== "func" || callbackExpr.type.params.length > 1) {
      this.unsupported("fs.rename callback type", expr.loc);
    }
    const callbackType = callbackExpr.type;
    const from = `sc_rt_${this.temporary++}`;
    const to = `sc_rt_${this.temporary++}`;
    const callback = `sc_rt_${this.temporary++}`;
    let invoke: string;
    const parameter = callbackType.params[0];
    if (parameter === undefined) {
      invoke = `let _ = sc_error; ${this.emitClosureDispatch(callback, callbackType, [], expr.loc)};`;
    } else {
      if (parameter.kind !== "union") this.unsupported("fs.rename callback error parameter", expr.loc);
      const union = this.union(parameter.unionId, expr.loc);
      const errorTag = union.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error");
      const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
      if (errorTag < 0 || nullTag < 0) this.unsupported("fs.rename callback Error | null union", expr.loc);
      const name = this.unionName(union.id);
      const errorPayload = this.errorClassRoots().length === 0
        ? "error"
        : `${this.errorValueName()}::Builtin(error)`;
      const argument = `match sc_error { Some(error) => ${name}::${this.unionVariant(errorTag)}(${errorPayload}), None => ${name}::${this.unionVariant(nullTag)}, }`;
      invoke = `let sc_argument = ${argument}; ${this.emitClosureDispatch(callback, callbackType, ["sc_argument"], expr.loc)};`;
    }
    return `{ let ${from} = ${this.emitExpr(fromExpr)}; let ${to} = ${this.emitExpr(toExpr)}; let ${callback} = ${this.emitExpr(callbackExpr)}; runtime::fs_rename_async(&${from}, &${to}, Box::new(move |sc_error| { ${invoke} })); }`;
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
      case "date": return "true";
      case "bytes": return "true";
      case "map": return "true";
      case "set": return "true";
      case "stats": return "true";
      case "fileHandle": return "true";
      case "spawnRes": return "true";
      case "record": return "true";
      case "object": return "true";
      case "func": return "true";
      case "promise": return "true";
      case "regex": return "true";
      case "symbol": return "true";
      case "url": return "true";
      case "searchParams": return "true";
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
      if (this.isHeapRoot(type) || type.kind === "regex" || type.kind === "symbol" || type.kind === "url" || type.kind === "searchParams") {
        return `${name}.with(|slot| slot.borrow().as_ref().expect("scriptc: uninitialized global").clone())`;
      }
      if (this.needsClone(type)) return `${name}.with(|slot| slot.borrow().clone())`;
      if (type.kind === "f64" || type.kind === "date" || type.kind === "bool" || type.kind === "classval") return `${name}.with(Cell::get)`;
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
      if (this.isHeapRoot(global.type) || global.type.kind === "regex" || global.type.kind === "symbol" || global.type.kind === "url" || global.type.kind === "searchParams") return `${name}.with(|slot| *slot.borrow_mut() = Some(${value}));`;
      if (this.needsClone(global.type)) return `${name}.with(|slot| *slot.borrow_mut() = ${value});`;
      if (global.type.kind === "f64" || global.type.kind === "date" || global.type.kind === "bool" || global.type.kind === "classval") return `${name}.with(|slot| slot.set(${value}));`;
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

  private rustBytesElement(elem: "u8" | "u32" | "i32" | "f32"): string {
    return elem;
  }

  private rustType(type: IrType, loc?: SrcLoc): string {
    switch (type.kind) {
      case "void": return "()";
      case "f64": return "f64";
      case "date": return "f64";
      case "bool": return "bool";
      case "string": return "runtime::JsString";
      case "classval": {
        this.classMetaOf(type.className, loc);
        return "usize";
      }
      case "array": return `runtime::JsArray<${this.rustType(type.elem, loc)}>`;
      case "bytes": return `runtime::JsBytes<${this.rustBytesElement(type.elem)}>`;
      case "stats": return "runtime::JsStats";
      case "fileHandle": return "runtime::JsFileHandle";
      case "spawnRes": return "runtime::JsSpawnResult";
      case "map": return `runtime::JsMap<${this.rustType(type.key, loc)}, ${this.rustType(type.value, loc)}>`;
      case "set": return `runtime::JsSet<${this.rustType(type.elem, loc)}>`;
      case "record": {
        const shape = this.records.get(type.shapeId);
        if (shape === undefined) this.unsupported(`unknown record type '${type.shapeId}'`, loc);
        if (shape.indexValue !== undefined) {
          if (shape.fields.length === 0) {
            const value = shape.indexValue.kind === "dyn"
              ? this.dynTypeName()
              : this.rustType(shape.indexValue, loc);
            return `runtime::JsMap<runtime::JsString, ${value}>`;
          }
          this.unsupported(`indexed record value '${type.shapeId}'`, loc);
        }
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
      case "regex": return "runtime::JsRegex";
      case "symbol": return "runtime::JsSymbol";
      case "url": return "runtime::JsUrl";
      case "searchParams": return "runtime::JsSearchParams";
      case "caught": return "runtime::Caught";
      case "dyn": return this.dynTypeName();
      default: this.unsupported(`type '${type.kind}'`, loc);
    }
  }

  private defaultValue(type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64": return "0.0";
      case "date": return "0.0";
      case "bool": return "false";
      case "string": return "runtime::empty_string()";
      case "symbol": return "runtime::symbol_new_anonymous()";
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
    return this.containerExpressions.emitArrayIntrinsic(expr);
  }

  private emitArrayGetValues(
    expr: Extract<IrExpr, { kind: "arrayGet" }>,
    array: string,
    index: string,
  ): string {
    return this.containerExpressions.emitArrayGetValues(expr, array, index);
  }

  private emitBytesNewValue(
    expr: Extract<IrExpr, { kind: "bytesNew" }>,
    source: string | null,
  ): string {
    return this.containerExpressions.emitBytesNewValue(expr, source);
  }

  private emitArrayIntrinsicValues(
    expr: Extract<IrExpr, { kind: "arrIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    return this.containerExpressions.emitArrayIntrinsicValues(expr, receiver, args);
  }

  private emitMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string {
    return this.containerExpressions.emitMapIntrinsic(expr);
  }

  private emitMapIntrinsicValues(
    expr: Extract<IrExpr, { kind: "mapIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    return this.containerExpressions.emitMapIntrinsicValues(expr, receiver, args);
  }

  private emitSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string {
    return this.containerExpressions.emitSetIntrinsic(expr);
  }

  private needsClone(type: IrType): boolean {
    return type.kind === "string" || type.kind === "regex" || type.kind === "symbol" || type.kind === "url" || type.kind === "searchParams" || type.kind === "union" || type.kind === "caught" || type.kind === "dyn" ||
      (type.kind === "object" && RUNTIME_ERROR_CLASSES.has(type.className)) || this.isTracedHandle(type);
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
      case "symbol":
        return `runtime::symbol_ptr_eq(${left}, ${right})`;
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
    if (type.kind === "symbol") return `runtime::symbol_ptr_eq(${left}, ${right})`;
    this.unsupported(`map key '${type.kind}'`, loc);
  }

  private mapStoredKey(value: string, type: IrType): string {
    return type.kind === "f64" ? `if ${value} == 0.0 { 0.0 } else { ${value} }` : value;
  }

  private isTracedHandle(type: IrType): boolean {
    return type.kind === "array" || type.kind === "bytes" || type.kind === "map" || type.kind === "set" || type.kind === "stats" || type.kind === "fileHandle" || type.kind === "spawnRes" || type.kind === "record" || type.kind === "promise" ||
      (type.kind === "object" && (this.classes.has(type.className) ||
        (RUNTIME_ERROR_CLASSES.has(type.className) && this.errorClassRoots().length > 0))) || type.kind === "func";
  }

  private isEdgeValue(type: IrType): boolean {
    return this.isTracedHandle(type) || type.kind === "union" || type.kind === "dyn";
  }

  private isHeapRoot(type: IrType): boolean {
    return this.isEdgeValue(type) || (type.kind === "object" && RUNTIME_ERROR_CLASSES.has(type.className));
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
        if (shape === undefined) return false;
        const next = new Set(visiting).add(key);
        if (shape.indexValue !== undefined) {
          return shape.fields.length === 0 && this.isRustJsonCompatible(shape.indexValue, next);
        }
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
      case "regex":
      case "symbol":
      case "url":
      case "searchParams":
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

  private dynTypeName(): string {
    return "sc_dyn_value";
  }

  private dynFunctionVariant(shape: RustClosureShape): string {
    return `Function${shape.index}`;
  }

  private dynFunctionCheckName(shape: RustClosureShape): string {
    return `sc_dyn_check_function_${shape.index}`;
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
