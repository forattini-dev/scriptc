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
import { RustValueEmitter } from "./values.js";
import { RustFunctionValueEmitter } from "./function-values.js";
import { RustDefinitionEmitter } from "./definitions.js";
import { RustMetadata } from "./metadata.js";
import { RustEventEmitterEmitter } from "./event-emitter.js";
import type { IrFuncType, RustClassMeta, RustClosureShape, RustVtSlot } from "./model.js";
import {
  mangleFnClosure,
  mangleFunction,
  mangleGlobal,
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
  private readonly emitterListenerShapes = new Map<string, RustClosureShape>();
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
  private readonly loopTargets: {
    id: number;
    breakLabel: string;
    continueBlock: string | null;
    allowsContinue: boolean;
  }[] = [];
  private readonly completionLoopBoundaries: number[] = [];
  private readonly forcedBoxedLocals = new Set<string>();
  private nextLoopTargetId = 0;
  private usesDyn = false;
  private usesDynamicInvoke = false;
  private usesEventEmitter = false;
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
    usesDynamicInvoke: () => this.usesDynamicInvoke,
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
  private readonly eventEmitter = new RustEventEmitterEmitter({
    listenerShapes: this.emitterListenerShapes,
    isUsed: () => this.usesEventEmitter,
    line: (value) => this.line(value),
    pushIndent: () => { this.indent += 1; },
    popIndent: () => { this.indent -= 1; },
    nextTemporary: () => `sc_rt_${this.temporary++}`,
    emitExpr: (expr) => this.emitExpr(expr),
    closureName: (shape) => this.closureName(shape),
    closureShapeForType: (type, loc) => this.closureShapeForType(type, loc),
    emitClosureDispatch: (callee, type, args, loc) => this.emitClosureDispatch(callee, type, args, loc),
    sourceLoc: () => this.mod.functions[0]?.loc ?? { file: "<builtin>", start: 0, end: 0 },
    needsClone: (type) => this.needsClone(type),
    rustString: (value) => this.rustString(value),
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
    emitEventEmitterCall: (expr) => this.eventEmitter.emitLibCall(expr),
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
  private readonly valueEmitter = new RustValueEmitter({
    classes: this.classes,
    globals: this.globals,
    records: this.records,
    unions: this.unions,
    currentFunction: () => this.currentFunction,
    isForcedBoxed: (id) => this.forcedBoxedLocals.has(id),
    line: (value) => this.line(value),
    emitExpr: (expr) => this.emitExpr(expr),
    classMetaOf: (name, loc) => this.classMetaOf(name, loc),
    classStructName: (name, loc) => this.classStructName(name, loc),
    closureName: (shape) => this.closureName(shape),
    closureShapeForType: (type, loc) => this.closureShapeForType(type, loc),
    dynTypeName: () => this.dynTypeName(),
    errorClassRoots: () => this.errorClassRoots(),
    errorValueName: () => this.errorValueName(),
    rustString: (value) => this.rustString(value),
    union: (id, loc) => this.union(id, loc),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    emitContainerArrayIntrinsic: (expr) => this.containerExpressions.emitArrayIntrinsic(expr),
    emitContainerArrayGetValues: (expr, array, index) =>
      this.containerExpressions.emitArrayGetValues(expr, array, index),
    emitContainerBytesNewValue: (expr, source) => this.containerExpressions.emitBytesNewValue(expr, source),
    emitContainerArrayIntrinsicValues: (expr, receiver, args) =>
      this.containerExpressions.emitArrayIntrinsicValues(expr, receiver, args),
    emitContainerMapIntrinsic: (expr) => this.containerExpressions.emitMapIntrinsic(expr),
    emitContainerMapIntrinsicValues: (expr, receiver, args) =>
      this.containerExpressions.emitMapIntrinsicValues(expr, receiver, args),
    emitContainerSetIntrinsic: (expr) => this.containerExpressions.emitSetIntrinsic(expr),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
  });
  private readonly functionValueEmitter = new RustFunctionValueEmitter({
    closureTargets: this.closureTargets,
    dynAdapterShapes: this.dynAdapterShapes,
    functions: this.functions,
    promiseRejectorTypes: this.promiseRejectorTypes,
    promiseResolverTypes: this.promiseResolverTypes,
    records: this.records,
    nextName: (prefix) => `${prefix}_${this.temporary++}`,
    emitSequenceBinding: (statements, emitResult, binding) => {
      const start = this.lines.length;
      const previousIndent = this.indent;
      this.indent = 0;
      this.emitStatements(statements);
      const result = emitResult();
      const emittedStatements = this.lines.splice(start).join(" ");
      this.indent = previousIndent;
      return `${emittedStatements} let ${binding} = ${result};`;
    },
    captureField: (index) => this.captureField(index),
    closureName: (shape) => this.closureName(shape),
    closureShapeForType: (type, loc) => this.closureShapeForType(type, loc),
    closureVariant: (target) => this.closureVariant(target),
    emitDynCheckValue: (type, value, loc) => this.emitDynCheckValue(type, value, loc),
    emitDynFromValue: (type, value, loc, functionName) => this.emitDynFromValue(type, value, loc, functionName),
    emitExpr: (expr) => this.emitExpr(expr),
    errorClassRoots: () => this.errorClassRoots(),
    errorValueName: () => this.errorValueName(),
    isEdgeValue: (type) => this.isEdgeValue(type),
    isTracedHandle: (type) => this.isTracedHandle(type),
    isUnit: (type) => this.isUnit(type),
    local: (id, loc) => this.local(id, loc),
    union: (id, loc) => this.union(id, loc),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
  });
  private readonly definitionEmitter = new RustDefinitionEmitter({
    classMeta: this.classMeta,
    closureShapes: this.closureShapes,
    closureTargets: this.closureTargets,
    dynAdapterShapes: this.dynAdapterShapes,
    globals: this.globals,
    internedClosureTargets: this.internedClosureTargets,
    promiseRejectorTypes: this.promiseRejectorTypes,
    promiseResolverTypes: this.promiseResolverTypes,
    records: this.records,
    unions: this.unions,
    line: (value) => this.line(value),
    pushIndent: () => { this.indent += 1; },
    popIndent: () => { this.indent -= 1; },
    nextName: (prefix) => `${prefix}_${this.temporary++}`,
    setCurrentFunction: (fn) => { this.currentFunction = fn; },
    setCurrentAsyncResult: (result) => { this.currentAsyncResult = result; },
    setCurrentAsyncLocals: (locals) => { this.currentAsyncLocals = locals; },
    emitDynamicDefinition: () => this.dynamicEmitter.emitDynamicDefinition(),
    emitDynFromValue: (type, value, loc, functionName) =>
      this.dynamicEmitter.emitDynFromValue(type, value, loc, functionName),
    emitDynCheckValue: (type, value, loc) => this.dynamicEmitter.emitDynCheckValue(type, value, loc),
    emitAsyncStatements: (statements, onComplete) => this.emitAsyncStatements(statements, onComplete),
    emitStatements: (statements) => this.emitStatements(statements),
    captureField: (index) => this.captureField(index),
    classFieldName: (className, fieldName, loc) => this.classFieldName(className, fieldName, loc),
    classFieldStorageName: (owner, fieldName) => this.classFieldStorageName(owner, fieldName),
    classStructName: (name, loc) => this.classStructName(name, loc),
    closureName: (shape) => this.closureName(shape),
    closureVariant: (target) => this.closureVariant(target),
    dynTypeName: () => this.dynTypeName(),
    ensureUnionArm: (type) => this.ensureUnionArm(type),
    errorClassRoots: () => this.errorClassRoots(),
    errorValueName: () => this.errorValueName(),
    errorValueVariant: (meta) => this.errorValueVariant(meta),
    hierarchyFields: (root) => this.hierarchyFields(root),
    isEdgeValue: (type) => this.isEdgeValue(type),
    isRustJsonCompatible: (type, visiting) => this.isRustJsonCompatible(type, visiting),
    isTracedHandle: (type) => this.isTracedHandle(type),
    isUnit: (type) => this.isUnit(type),
    runtimeErrorClassNames: (name) => this.runtimeErrorClassNames(name),
    rustString: (value) => this.rustString(value),
    rustType: (type, loc) => this.rustType(type, loc),
    union: (id, loc) => this.union(id, loc),
    unionEqName: (id) => this.unionEqName(id),
    unionName: (id) => this.unionName(id),
    unionVariant: (tag) => this.unionVariant(tag),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
  });
  private readonly metadata = new RustMetadata({
    classMeta: this.classMeta,
    classes: this.classes,
    closureShapes: this.closureShapes,
    functions: this.functions,
    promiseRejectorTypes: this.promiseRejectorTypes,
    unions: this.unions,
    module: () => this.mod,
    nextName: (prefix) => `${prefix}_${this.temporary++}`,
    defaultValue: (type, loc) => this.defaultValue(type, loc),
    isEdgeValue: (type) => this.isEdgeValue(type),
    unsupported: (kind, loc) => this.unsupported(kind, loc),
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
    this.eventEmitter.emitDefinition();
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
    if (this.usesDynamicInvoke) this.line("sc_dyn_function_cache_clear();");
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
      if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("emitter.")) {
        this.usesEventEmitter = true;
        if (node.fn === "emitter.on") {
          const callback = (node.args as { type?: IrType }[] | undefined)?.[2];
          if (callback?.type?.kind !== "func") this.unsupported("malformed EventEmitter listener IR");
          const shape = this.ensureClosureShape(callback.type);
          this.emitterListenerShapes.set(typeKey(callback.type), shape);
        }
      }
      if (node.kind === "dynInvoke" || node.kind === "dynHasKey" || node.kind === "dynScalarEq" ||
        (node.kind === "libCall" && (node.fn === "dyn.this" || node.fn === "dyn.defineProps"))) {
        this.usesDynamicInvoke = true;
      }
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

  private emitClosureDefinitions(): void { this.definitionEmitter.emitClosureDefinitions(); }

  private emitDynamicDefinition(): void { this.definitionEmitter.emitDynamicDefinition(); }

  private emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName = ""): string {
    return this.definitionEmitter.emitDynFromValue(type, value, loc, functionName);
  }

  private emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string {
    return this.definitionEmitter.emitDynCheckValue(type, value, loc);
  }

  private emitUnionDefinitions(): void { this.definitionEmitter.emitUnionDefinitions(); }
  private emitRecordDefinitions(): void { this.definitionEmitter.emitRecordDefinitions(); }
  private emitClassDefinitions(): void { this.definitionEmitter.emitClassDefinitions(); }
  private emitErrorValueDefinition(): void { this.definitionEmitter.emitErrorValueDefinition(); }
  private emitGlobals(): void { this.definitionEmitter.emitGlobals(); }
  private emitFunction(fn: IrFunction): void { this.definitionEmitter.emitFunction(fn); }

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
      forceBoxedLocal: (id, forced) => {
        if (forced) this.forcedBoxedLocals.add(id);
        else this.forcedBoxedLocals.delete(id);
      },
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
    return this.functionValueEmitter.emitClosure(expr);
  }

  private emitCallValue(expr: Extract<IrExpr, { kind: "callValue" }>): string {
    return this.functionValueEmitter.emitCallValue(expr);
  }

  private emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string {
    return this.functionValueEmitter.emitClosureDispatch(callee, type, args, loc);
  }

  private emitBinary(expr: Extract<IrExpr, { kind: "bin" }>): string {
    return this.functionValueEmitter.emitBinary(expr);
  }

  private emitBinaryValues(
    expr: Extract<IrExpr, { kind: "bin" }>,
    left: string,
    right: string,
  ): string {
    return this.functionValueEmitter.emitBinaryValues(expr, left, right);
  }

  private emitToStringValue(type: IrType, operand: string, loc: SrcLoc): string {
    return this.functionValueEmitter.emitToStringValue(type, operand, loc);
  }

  private emitPromiseFromSync(
    args: readonly IrExpr[],
    operation: (value: (index: number) => string) => string,
  ): string {
    return this.functionValueEmitter.emitPromiseFromSync(args, operation);
  }

  private emitFileHandleTransferPromise(expr: Extract<IrExpr, { kind: "libCall" }>): string {
    return this.functionValueEmitter.emitFileHandleTransferPromise(expr);
  }

  private emitFsRenameCallback(expr: Extract<IrExpr, { kind: "libCall" }>): string {
    return this.functionValueEmitter.emitFsRenameCallback(expr);
  }

  private emitPromiseRaceValue(from: IrType, to: IrType, value: string, loc: SrcLoc): string {
    return this.functionValueEmitter.emitPromiseRaceValue(from, to, value, loc);
  }

  private displayExpr(expr: IrExpr): string { return this.valueEmitter.displayExpr(expr); }

  private displayValue(value: string, type: IrType, loc: SrcLoc): string {
    return this.valueEmitter.displayValue(value, type, loc);
  }

  private truthiness(value: string, type: IrType, loc: SrcLoc): string {
    return this.valueEmitter.truthiness(value, type, loc);
  }

  private emitRead(id: string, type: IrType, loc: SrcLoc): string {
    return this.valueEmitter.emitRead(id, type, loc);
  }

  private emitAssignment(id: string, value: string, loc: SrcLoc): void {
    this.valueEmitter.emitAssignment(id, value, loc);
  }

  private assignmentExpr(id: string, value: string, loc: SrcLoc): string {
    return this.valueEmitter.assignmentExpr(id, value, loc);
  }

  private local(id: string, loc: SrcLoc) { return this.valueEmitter.local(id, loc); }

  private localIsBoxed(local: IrFunction["locals"][number]): boolean {
    return this.valueEmitter.localIsBoxed(local);
  }

  private rustBytesElement(elem: "u8" | "u32" | "i32" | "f32"): string {
    return this.valueEmitter.rustBytesElement(elem);
  }

  private rustType(type: IrType, loc?: SrcLoc): string { return this.valueEmitter.rustType(type, loc); }

  private defaultValue(type: IrType, loc: SrcLoc): string {
    return this.valueEmitter.defaultValue(type, loc);
  }

  private numberLiteral(value: number): string { return this.valueEmitter.numberLiteral(value); }

  private emitArrayIntrinsic(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>): string {
    return this.valueEmitter.emitArrayIntrinsic(expr);
  }

  private emitArrayGetValues(
    expr: Extract<IrExpr, { kind: "arrayGet" }>,
    array: string,
    index: string,
  ): string {
    return this.valueEmitter.emitArrayGetValues(expr, array, index);
  }

  private emitBytesNewValue(
    expr: Extract<IrExpr, { kind: "bytesNew" }>,
    source: string | null,
  ): string {
    return this.valueEmitter.emitBytesNewValue(expr, source);
  }

  private emitArrayIntrinsicValues(
    expr: Extract<IrExpr, { kind: "arrIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    return this.valueEmitter.emitArrayIntrinsicValues(expr, receiver, args);
  }

  private emitMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string {
    return this.valueEmitter.emitMapIntrinsic(expr);
  }

  private emitMapIntrinsicValues(
    expr: Extract<IrExpr, { kind: "mapIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    return this.valueEmitter.emitMapIntrinsicValues(expr, receiver, args);
  }

  private emitSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string {
    return this.valueEmitter.emitSetIntrinsic(expr);
  }

  private needsClone(type: IrType): boolean { return this.valueEmitter.needsClone(type); }

  private arrayElementEquality(
    left: string,
    right: string,
    type: IrType,
    sameValueZero: boolean,
    loc: SrcLoc,
  ): string {
    return this.valueEmitter.arrayElementEquality(left, right, type, sameValueZero, loc);
  }

  private mapKeyEquality(left: string, right: string, type: IrType, loc: SrcLoc): string {
    return this.valueEmitter.mapKeyEquality(left, right, type, loc);
  }

  private mapStoredKey(value: string, type: IrType): string {
    return this.valueEmitter.mapStoredKey(value, type);
  }

  private isTracedHandle(type: IrType): boolean { return this.valueEmitter.isTracedHandle(type); }
  private isEdgeValue(type: IrType): boolean { return this.valueEmitter.isEdgeValue(type); }
  private isHeapRoot(type: IrType): boolean { return this.valueEmitter.isHeapRoot(type); }
  private isUnit(type: IrType): boolean { return this.valueEmitter.isUnit(type); }

  private isRustJsonCompatible(type: IrType, visiting = new Set<string>()): boolean {
    return this.valueEmitter.isRustJsonCompatible(type, visiting);
  }

  private ensureUnionArm(type: IrType): void { this.valueEmitter.ensureUnionArm(type); }

  private closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape {
    return this.metadata.closureShapeForType(type, loc);
  }

  private classDef(name: string, loc?: SrcLoc): IrClassDef { return this.metadata.classDef(name, loc); }
  private stripCasts(expr: IrExpr): IrExpr { return this.metadata.stripCasts(expr); }
  private runtimeErrorAncestor(name: string): string | null { return this.metadata.runtimeErrorAncestor(name); }
  private errorClassRoots(): RustClassMeta[] { return this.metadata.errorClassRoots(); }
  private errorValueName(): string { return this.metadata.errorValueName(); }
  private errorValueVariant(meta: RustClassMeta): string { return this.metadata.errorValueVariant(meta); }
  private runtimeErrorClassNames(name: string): string[] { return this.metadata.runtimeErrorClassNames(name); }
  private runtimeErrorIsA(source: string, target: string): boolean {
    return this.metadata.runtimeErrorIsA(source, target);
  }
  private classMetaOf(name: string, loc?: SrcLoc): RustClassMeta { return this.metadata.classMetaOf(name, loc); }
  private classStructName(name: string, loc?: SrcLoc): string { return this.metadata.classStructName(name, loc); }

  private hierarchyFields(
    root: RustClassMeta,
  ): { owner: RustClassMeta; field: IrClassDef["fields"][number] }[] {
    return this.metadata.hierarchyFields(root);
  }

  private classSubtree(meta: RustClassMeta): RustClassMeta[] { return this.metadata.classSubtree(meta); }

  private classAllocation(meta: RustClassMeta, args: readonly string[], loc: SrcLoc): string {
    return this.metadata.classAllocation(meta, args, loc);
  }

  private classFieldName(className: string, fieldName: string, loc?: SrcLoc): string {
    return this.metadata.classFieldName(className, fieldName, loc);
  }

  private classFieldStorageName(owner: RustClassMeta, fieldName: string): string {
    return this.metadata.classFieldStorageName(owner, fieldName);
  }

  private virtualImplementation(meta: RustClassMeta, slot: RustVtSlot): IrFunction {
    return this.metadata.virtualImplementation(meta, slot);
  }

  private closureName(shape: RustClosureShape): string { return this.metadata.closureName(shape); }
  private dynTypeName(): string { return this.metadata.dynTypeName(); }
  private dynFunctionVariant(shape: RustClosureShape): string { return this.metadata.dynFunctionVariant(shape); }
  private dynFunctionCheckName(shape: RustClosureShape): string { return this.metadata.dynFunctionCheckName(shape); }

  private promiseRejectorVariant(type: IrFuncType, promiseType: IrType, loc?: SrcLoc): string {
    return this.metadata.promiseRejectorVariant(type, promiseType, loc);
  }

  private closureVariant(target: IrFunction): string { return this.metadata.closureVariant(target); }
  private captureField(index: number): string { return this.metadata.captureField(index); }
  private union(id: string, loc?: SrcLoc): IrUnionDef { return this.metadata.union(id, loc); }
  private unionName(id: string): string { return this.metadata.unionName(id); }
  private unionVariant(tag: number): string { return this.metadata.unionVariant(tag); }
  private unionEqName(id: string): string { return this.metadata.unionEqName(id); }
  private rustString(value: string): string { return this.metadata.rustString(value); }

  private line(value: string): void {
    this.lines.push(`${"    ".repeat(this.indent)}${value}`);
  }

  private unsupported(kind: string, loc?: SrcLoc): never {
    throw new RustUnsupportedError(kind, loc);
  }
}
