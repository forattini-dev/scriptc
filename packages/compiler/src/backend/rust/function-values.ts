import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import { mangleField, mangleFnClosure, mangleFunction, mangleLocal, mangleRecordStruct } from "../mangle.js";
import type { IrFuncType, RustClassMeta, RustClosureShape } from "./model.js";

export interface RustFunctionValueContext {
  readonly closureTargets: ReadonlyMap<string, RustClosureShape>;
  readonly dynAdapterShapes: ReadonlySet<string>;
  readonly emitterSnapshotShapes: ReadonlyMap<string, RustClosureShape>;
  readonly functions: ReadonlyMap<string, IrFunction>;
  readonly promiseRejectorTypes: ReadonlyMap<string, IrType[]>;
  readonly promiseResolverTypes: ReadonlyMap<string, IrType>;
  readonly records: ReadonlyMap<string, IrRecordShape>;
  nextName(prefix: string): string;
  emitSequenceBinding(statements: readonly IrStmt[], emitResult: () => string, binding: string): string;
  captureField(index: number): string;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  closureVariant(target: IrFunction): string;
  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string;
  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName?: string): string;
  emitExpr(expr: IrExpr): string;
  errorClassRoots(): RustClassMeta[];
  errorValueName(): string;
  isEdgeValue(type: IrType): boolean;
  isTracedHandle(type: IrType): boolean;
  isUnit(type: IrType): boolean;
  local(id: string, loc: SrcLoc): IrFunction["locals"][number];
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustFunctionValueEmitter {
  constructor(private readonly context: RustFunctionValueContext) {}

  emitClosure(expr: Extract<IrExpr, { kind: "closure" }>): string {
    if (expr.type.kind !== "func") this.context.unsupported("closure with a non-function type", expr.loc);
    const shape = this.context.closureShapeForType(expr.type, expr.loc);
    const target = this.context.functions.get(expr.fnName);
    if (target === undefined || this.context.closureTargets.get(target.name) !== shape) {
      this.context.unsupported(`unknown closure target '${expr.fnName}'`, expr.loc);
    }
    const targetCaptures = target.captures ?? [];
    if (targetCaptures.length !== expr.captures.length) {
      this.context.unsupported(`capture arity for '${target.name}'`, expr.loc);
    }
    const variant = `${this.context.closureName(shape)}::${this.context.closureVariant(target)}`;
    let payload = variant;
    if (targetCaptures.length > 0) {
      const fields = targetCaptures.map((capture, index) => {
        const localId = expr.captures[index];
        if (localId === undefined) this.context.unsupported(`missing capture ${index} for '${target.name}'`, expr.loc);
        const local = this.context.local(localId, expr.loc);
        if (!local.boxed) this.context.unsupported(`unboxed capture '${local.name}'`, expr.loc);
        return `${this.context.captureField(index)}: Some(${mangleLocal(localId)}.clone())`;
      }).join(", ");
      payload = `${variant} { ${fields} }`;
    }
    const allocated = `runtime::Gc::new(${payload})`;
    if (target.captures !== undefined) return allocated;
    const slot = mangleFnClosure(target.name);
    const value = this.context.nextName("sc_rt");
    return `${slot}.with(|slot| { let mut slot = slot.borrow_mut(); if let Some(value) = slot.as_ref() { value.clone() } else { let ${value} = ${allocated}; *slot = Some(${value}.clone()); ${value} } })`;
  }

  emitCallValue(expr: Extract<IrExpr, { kind: "callValue" }>): string {
    if (expr.callee.type.kind !== "func") this.context.unsupported("callValue with a non-function callee", expr.loc);
    const shape = this.context.closureShapeForType(expr.callee.type, expr.loc);
    if (expr.args.length !== shape.type.params.length) {
      this.context.unsupported("callValue argument arity", expr.loc);
    }
    const callee = this.context.nextName("sc_rt");
    const args = expr.args.map(() => this.context.nextName("sc_rt"));
    const bindings = [
      `let ${callee} = ${this.context.emitExpr(expr.callee)};`,
      ...expr.args.map((arg, index) => `let ${args[index]} = ${this.context.emitExpr(arg)};`),
    ].join(" ");
    return `{ ${bindings} ${this.emitClosureDispatch(callee, expr.callee.type, args, expr.loc)} }`;
  }

  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string {
    const shape = this.context.closureShapeForType(type, loc);
    const abiArity = shape.type.params.length + (shape.type.rest === true ? 1 : 0);
    if (args.length !== abiArity) this.context.unsupported("closure dispatch argument arity", loc);
    const arms = shape.targets.map((target) => {
      const captures = target.captures ?? [];
      const variant = `${this.context.closureName(shape)}::${this.context.closureVariant(target)}`;
      const fields = captures.map((_, index) => this.context.captureField(index));
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
    const resolverType = this.context.promiseResolverTypes.get(typeKey(shape.type));
    if (resolverType !== undefined) {
      const expectedArity = resolverType.kind === "void" ? 0 : 1;
      if (args.length !== expectedArity) this.context.unsupported("Promise resolver argument arity", loc);
      const value = args[0] ?? "()";
      arms.push(`${this.context.closureName(shape)}::PromiseResolver { promise } => { let promise = promise.as_ref().expect("scriptc: cleared live Promise resolver"); let _ = runtime::promise_fulfill(promise, ${value}); }`);
    }
    const rejectorTypes = this.context.promiseRejectorTypes.get(typeKey(shape.type)) ?? [];
    if (rejectorTypes.length > 0) {
      if (args.length !== 1) this.context.unsupported("Promise rejector argument arity", loc);
      const reason = args[0];
      if (reason === undefined) this.context.unsupported("Promise rejector without a reason", loc);
      for (let index = 0; index < rejectorTypes.length; index += 1) {
        arms.push(`${this.context.closureName(shape)}::PromiseRejector${index} { promise } => { let promise = promise.as_ref().expect("scriptc: cleared live Promise rejector"); let _ = runtime::promise_reject(promise, runtime::caught_value(${reason})); }`);
      }
    }
    if (this.context.dynAdapterShapes.has(typeKey(shape.type))) {
      const dynamicArgs = shape.type.params.map((param, index) => {
        const arg = args[index];
        if (arg === undefined) this.context.unsupported("dynamic adapter argument arity", loc);
        return this.context.emitDynFromValue(param, arg, loc);
      }).join(", ");
      const call = `sc_dyn_call(value.as_ref().expect("scriptc: cleared live dynamic function adapter"), &sc_dyn_args, "value")`;
      let result: string;
      if (shape.type.ret.kind === "void") {
        result = `{ let _ = ${call}; () }`;
      } else {
        result = this.context.emitDynCheckValue(shape.type.ret, call, loc);
      }
      arms.push(`${this.context.closureName(shape)}::DynAdapter { value } => { let sc_dyn_args = [${dynamicArgs}]; ${result} }`);
    }
    if (this.context.emitterSnapshotShapes.has(typeKey(shape.type))) {
      const passed = [`listener.as_ref().expect("scriptc: cleared live EventEmitter listener adapter")`, ...args];
      arms.push(`${this.context.closureName(shape)}::EventAdapter { listener, .. } => sc_emitter_dispatch_snapshot_${shape.index}(${passed.join(", ")})`);
    }
    return `${callee}.with(|closure| match closure { ${arms.join(", ")} })`;
  }

  emitBinary(expr: Extract<IrExpr, { kind: "bin" }>): string {
    const left = this.context.emitExpr(expr.left);
    const right = this.context.emitExpr(expr.right);
    return this.emitBinaryValues(expr, left, right);
  }

  emitBinaryValues(expr: Extract<IrExpr, { kind: "bin" }>, left: string, right: string): string {
    if ((expr.left.type.kind === "regex" || expr.left.type.kind === "symbol" || expr.left.type.kind === "url" || expr.left.type.kind === "searchParams" || expr.left.type.kind === "generator") &&
        (expr.op === "===" || expr.op === "!==")) {
      const compare = expr.left.type.kind === "generator"
        ? `runtime::generator_ptr_eq(&(${left}), &(${right}))`
        : `std::rc::Rc::ptr_eq(&(${left}), &(${right}))`;
      return expr.op === "!==" ? `!(${compare})` : compare;
    }
    if (expr.left.type.kind === "func" && expr.right.type.kind === "func" &&
        (expr.op === "===" || expr.op === "!==")) {
      const compare = `${this.functionIdentity(left, expr.left.type, expr.loc)} == ${this.functionIdentity(right, expr.right.type, expr.loc)}`;
      return expr.op === "!==" ? `!(${compare})` : compare;
    }
    if (this.context.isTracedHandle(expr.left.type) && (expr.op === "===" || expr.op === "!==")) {
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

  emitToStringValue(type: IrType, operand: string, loc: SrcLoc): string {
    if (type.kind === "f64") return `runtime::number_to_string(${operand})`;
    if (type.kind === "bool") return `runtime::bool_to_string(${operand})`;
    if (type.kind === "dyn") return `sc_dyn_to_string(&(${operand}))`;
    if (type.kind === "record") return `{ let _ = ${operand}; runtime::string("[object Object]") }`;
    if (type.kind === "caught") {
      const helper = this.context.errorClassRoots().length === 0 ? "runtime::caught_to_string" : "sc_caught_to_string";
      return `${helper}(&(${operand}))`;
    }
    if (type.kind === "union") {
      const union = this.context.union(type.unionId, loc);
      const name = this.context.unionName(union.id);
      const arms = union.arms.map((arm, tag) => {
        const variant = `${name}::${this.context.unionVariant(tag)}`;
        if (arm.kind === "undefinedT") return `${variant} => runtime::string("undefined")`;
        if (arm.kind === "nullT") return `${variant} => runtime::string("null")`;
        if (arm.kind === "string") return `${variant}(value) => value`;
        if (arm.kind === "f64") return `${variant}(value) => runtime::number_to_string(value)`;
        if (arm.kind === "bool") return `${variant}(value) => runtime::bool_to_string(value)`;
        this.context.unsupported(`toString union arm '${arm.kind}'`, loc);
      }).join(", ");
      return `match ${operand} { ${arms} }`;
    }
    this.context.unsupported(`toString from '${type.kind}'`, loc);
  }

  private functionIdentity(value: string, type: IrFuncType, loc: SrcLoc): string {
    const shape = this.context.closureShapeForType(type, loc);
    return `sc_closure_identity_${shape.index}(&(${value}))`;
  }

  emitPromiseFromSync(
    args: readonly IrExpr[],
    operation: (value: (index: number) => string) => string,
  ): string {
    const values = args.map(() => this.context.nextName("sc_rt"));
    const value = (index: number): string => {
      const result = values[index];
      if (result === undefined) this.context.unsupported(`missing synchronous promise argument ${index}`);
      return result;
    };
    const bindings = args.map((arg, index) => {
      if (arg.kind !== "seqExpr") return `let ${value(index)} = ${this.context.emitExpr(arg)};`;
      // A sequence may declare a hidden local whose value is deliberately
      // consumed by a later argument (FileHandle's optional length marker is
      // one example). Keep every argument left-to-right, but let those
      // declarations live in this shared expression block rather than an
      // argument-private Rust block.
      return this.context.emitSequenceBinding(arg.stmts, () => this.context.emitExpr(arg.result), value(index));
    }).join(" ");
    return `{ ${bindings} runtime::promise_from_sync(move || ${operation(value)}) }`;
  }

  emitFileHandleTransferPromise(expr: Extract<IrExpr, { kind: "libCall" }>): string {
    if (expr.type.kind !== "promise" || expr.type.inner.kind !== "record") {
      this.context.unsupported(`${expr.fn} result without a record promise`, expr.loc);
    }
    const recordType = expr.type.inner;
    const shape = this.context.records.get(recordType.shapeId);
    if (shape === undefined) this.context.unsupported(`unknown FileHandle result shape '${recordType.shapeId}'`, expr.loc);
    const countField = expr.fn === "fileHandle.read" ? "bytesRead" : "bytesWritten";
    const expectedArgs = expr.fn === "fileHandle.writeStr" ? 4 : 6;
    if (expr.args.length !== expectedArgs || expr.args[1] === undefined) {
      this.context.unsupported(`${expr.fn} argument shape`, expr.loc);
    }
    const fields = shape.fields.map((field) => {
      if (field.name === countField) return `${mangleField(field.name)}: sc_count`;
      if (field.name === "buffer") {
        return `${mangleField(field.name)}: ${this.context.isEdgeValue(field.type) ? "Some(sc_buffer)" : "sc_buffer"}`;
      }
      this.context.unsupported(`unexpected FileHandle result field '${field.name}'`, expr.loc);
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

  emitFsRenameCallback(expr: Extract<IrExpr, { kind: "libCall" }>): string {
    const [fromExpr, toExpr, callbackExpr] = expr.args;
    if (fromExpr === undefined || toExpr === undefined || callbackExpr === undefined || expr.args.length !== 3) {
      this.context.unsupported("fs.rename callback argument shape", expr.loc);
    }
    if (callbackExpr.type.kind !== "func" || callbackExpr.type.params.length > 1) {
      this.context.unsupported("fs.rename callback type", expr.loc);
    }
    const callbackType = callbackExpr.type;
    const from = this.context.nextName("sc_rt");
    const to = this.context.nextName("sc_rt");
    const callback = this.context.nextName("sc_rt");
    let invoke: string;
    const parameter = callbackType.params[0];
    if (parameter === undefined) {
      invoke = `let _ = sc_error; ${this.emitClosureDispatch(callback, callbackType, [], expr.loc)};`;
    } else {
      if (parameter.kind !== "union") this.context.unsupported("fs.rename callback error parameter", expr.loc);
      const union = this.context.union(parameter.unionId, expr.loc);
      const errorTag = union.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error");
      const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
      if (errorTag < 0 || nullTag < 0) this.context.unsupported("fs.rename callback Error | null union", expr.loc);
      const name = this.context.unionName(union.id);
      const errorPayload = this.context.errorClassRoots().length === 0
        ? "error"
        : `${this.context.errorValueName()}::Builtin(error)`;
      const argument = `match sc_error { Some(error) => ${name}::${this.context.unionVariant(errorTag)}(${errorPayload}), None => ${name}::${this.context.unionVariant(nullTag)}, }`;
      invoke = `let sc_argument = ${argument}; ${this.emitClosureDispatch(callback, callbackType, ["sc_argument"], expr.loc)};`;
    }
    return `{ let ${from} = ${this.context.emitExpr(fromExpr)}; let ${to} = ${this.context.emitExpr(toExpr)}; let ${callback} = ${this.context.emitExpr(callbackExpr)}; runtime::fs_rename_async(&${from}, &${to}, Box::new(move |sc_error| { ${invoke} })); }`;
  }

  emitPromiseRaceValue(from: IrType, to: IrType, value: string, loc: SrcLoc): string {
    if (typeKey(from) === typeKey(to)) return value;
    if (to.kind !== "union") this.context.unsupported("Promise.race adapter to a non-union", loc);
    const target = this.context.union(to.unionId, loc);
    const targetTag = (type: IrType): number => {
      const tag = target.arms.findIndex((arm) => typeKey(arm) === typeKey(type));
      if (tag < 0) this.context.unsupported(`Promise.race result union missing '${typeKey(type)}'`, loc);
      return tag;
    };
    const targetName = this.context.unionName(target.id);
    if (from.kind !== "union") {
      const tag = targetTag(from);
      const variant = `${targetName}::${this.context.unionVariant(tag)}`;
      return this.context.isUnit(from) ? `{ let _ = ${value}; ${variant} }` : `${variant}(${value})`;
    }
    const source = this.context.union(from.unionId, loc);
    const sourceName = this.context.unionName(source.id);
    const arms = source.arms.map((arm, tag) => {
      const sourceVariant = `${sourceName}::${this.context.unionVariant(tag)}`;
      const targetVariant = `${targetName}::${this.context.unionVariant(targetTag(arm))}`;
      return this.context.isUnit(arm)
        ? `${sourceVariant} => ${targetVariant}`
        : `${sourceVariant}(payload) => ${targetVariant}(payload)`;
    }).join(", ");
    return `match ${value} { ${arms} }`;
  }

}
