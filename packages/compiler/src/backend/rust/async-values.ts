import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { shapeHasAccessorSlots, typeEquals } from "../../ir/nodes.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { RustAsyncHandlers } from "./async-control.js";
import type { IrAwaitExpr } from "./model.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";

export interface RustAsyncValueContext {
  readonly records: ReadonlyMap<string, IrRecordShape>;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextName(prefix: string): string;
  currentAsyncResult(): string | null;
  currentFunction(): IrFunction | null;
  containsAsyncSuspension(value: unknown): boolean;
  awaitExpression(expr: IrExpr | null): IrAwaitExpr | null;
  emitAwaitDependency(expr: IrAwaitExpr): string;
  emitAsyncProtectedValue(
    expr: IrExpr,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (value: string) => void,
  ): void;
  emitAsyncStatements(statements: readonly IrStmt[], onComplete?: (() => void) | null): void;
  emitExpr(expr: IrExpr): string;
  emitExprWithValues(expr: IrExpr, values: readonly (readonly [IrExpr, string])[]): string;
  emitBinaryValues(expr: Extract<IrExpr, { kind: "bin" }>, left: string, right: string): string;
  emitArrayGetValues(expr: Extract<IrExpr, { kind: "arrayGet" }>, array: string, index: string): string;
  emitBytesNewValue(expr: Extract<IrExpr, { kind: "bytesNew" }>, source: string | null): string;
  emitArrayIntrinsicValues(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>, receiver: string, args: readonly string[]): string;
  emitMapIntrinsicValues(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>, receiver: string, args: readonly string[]): string;
  emitToStringValue(type: IrType, operand: string, loc: SrcLoc): string;
  displayValue(value: string, type: IrType, loc: SrcLoc): string;
  needsClone(type: IrType): boolean;
  isEdgeValue(type: IrType): boolean;
  isUnit(type: IrType): boolean;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export function rustAsyncExpressionOperands(expr: IrExpr): readonly IrExpr[] | null {
  switch (expr.kind) {
    case "libCall":
    case "call":
    case "intrinsic":
      return expr.args;
    case "jsOp":
      return expr.args;
    case "arrayLit":
      return expr.elems;
    case "recordLit":
      return expr.fields.map((field) => field.value);
    case "bytesIntrinsic":
      return [expr.receiver, ...expr.args];
    case "dynCheck":
    case "dynFromJsval":
    case "jsExit":
      return [expr.value];
    case "jsonStringify":
      return [expr.value];
    default:
      return null;
  }
}

export class RustAsyncValueEmitter {
  constructor(private readonly context: RustAsyncValueContext) {}

  emitAsyncValue(expr: IrExpr, consume: (value: string) => void): void {
    const awaited = this.context.awaitExpression(expr);
    if (awaited !== null) {
      this.emitAsyncContinuation(this.context.emitAwaitDependency(awaited), consume, null);
      return;
    }
    if (expr.kind === "unionWrap" && this.context.containsAsyncSuspension(expr.value)) {
      const union = this.context.union(expr.unionId, expr.loc);
      const arm = union.arms[expr.tag];
      if (arm === undefined || this.context.isUnit(arm)) {
        this.context.unsupported(`async union wrapper '${expr.unionId}:${expr.tag}'`, expr.loc);
      }
      const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(expr.tag)}`;
      this.emitAsyncValue(expr.value, (value) => consume(`${variant}(${value})`));
      return;
    }
    if (expr.kind === "seqExpr" && this.context.containsAsyncSuspension(expr.result)) {
      if (expr.stmts.some((statement) => this.context.containsAsyncSuspension(statement))) {
        this.context.unsupported("suspending statement inside an async sequence expression", expr.loc);
      }
      this.context.emitAsyncStatements(expr.stmts, () => this.emitAsyncValue(expr.result, consume));
      return;
    }
    if (expr.kind === "ternary" &&
        (this.context.containsAsyncSuspension(expr.then) || this.context.containsAsyncSuspension(expr.else_))) {
      this.emitAsyncValue(expr.cond, (condition) => {
        this.context.line(`if ${condition} {`);
        this.context.pushIndent();
        this.emitAsyncValue(expr.then, consume);
        this.context.popIndent();
        this.context.line("} else {");
        this.context.pushIndent();
        this.emitAsyncValue(expr.else_, consume);
        this.context.popIndent();
        this.context.line("}");
      });
      return;
    }
    if (expr.kind === "nullish" && this.context.containsAsyncSuspension(expr.right)) {
      if (expr.left.type.kind !== "union") {
        this.context.unsupported("async nullish fallback over a non-union", expr.loc);
      }
      const source = this.context.union(expr.left.type.unionId, expr.loc);
      const result = expr.type.kind === "union" ? this.context.union(expr.type.unionId, expr.loc) : null;
      this.emitAsyncValue(expr.left, (left) => {
        this.context.line(`match ${left} {`);
        this.context.pushIndent();
        source.arms.forEach((arm, tag) => {
          const variant = `${this.context.unionName(source.id)}::${this.context.unionVariant(tag)}`;
          this.context.line(`${variant}${this.context.isUnit(arm) ? "" : "(payload)"} => {`);
          this.context.pushIndent();
          if (this.context.isUnit(arm)) {
            this.emitAsyncValue(expr.right, consume);
          } else if (result === null) {
            consume("payload");
          } else {
            const resultTag = result.arms.findIndex((candidate) => typeEquals(candidate, arm));
            if (resultTag < 0) {
              this.context.unsupported(`async nullish result lacks '${arm.kind}' arm`, expr.loc);
            }
            consume(`${this.context.unionName(result.id)}::${this.context.unionVariant(resultTag)}(payload)`);
          }
          this.context.popIndent();
          this.context.line("},");
        });
        this.context.popIndent();
        this.context.line("}");
      });
      return;
    }
    if (expr.kind === "bin") {
      this.emitAsyncValue(expr.left, (left) => {
        this.emitAsyncValue(expr.right, (right) => consume(this.context.emitBinaryValues(expr, left, right)));
      });
      return;
    }
    if (expr.kind === "toString") {
      this.emitAsyncValue(
        expr.operand,
        (value) => consume(this.context.emitToStringValue(expr.operand.type, value, expr.loc)),
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
        this.emitAsyncValue(expr.index, (index) => consume(this.context.emitArrayGetValues(expr, array, index)));
      });
      return;
    }
    if (expr.kind === "bytesNew" && expr.source !== null) {
      this.emitAsyncValue(expr.source, (source) => consume(this.context.emitBytesNewValue(expr, source)));
      return;
    }
    if (expr.kind === "mapIntrinsic") {
      this.emitAsyncValue(expr.receiver, (receiver) => {
        this.emitAsyncValues(expr.args, (args) => {
          consume(this.context.emitMapIntrinsicValues(expr, receiver, args));
        });
      });
      return;
    }
    if (expr.kind === "recordLit") {
      this.emitAsyncRecord(expr, consume);
      return;
    }
    if (expr.kind === "recordClone") {
      this.emitAsyncValue(expr.source, (source) => {
        const clone = this.context.nextName("sc_async_record_clone");
        this.context.line(`let ${clone} = ${this.emitRecordCloneInitial(expr, source)};`);
        this.emitAsyncRecordCloneOverrides(expr, clone, () => consume(clone));
      });
      return;
    }
    if (expr.kind === "arrIntrinsic") {
      this.emitAsyncValue(expr.receiver, (receiver) => {
        this.emitAsyncValues(expr.args, (args) => {
          consume(this.context.emitArrayIntrinsicValues(expr, receiver, args));
        });
      });
      return;
    }
    const operands = rustAsyncExpressionOperands(expr);
    if (operands !== null && operands.some((operand) => this.context.containsAsyncSuspension(operand))) {
      this.emitAsyncValues(operands, (values) => {
        consume(this.context.emitExprWithValues(
          expr,
          operands.map((operand, index) => [
            operand,
            values[index] ?? this.context.unsupported("missing async expression operand", operand.loc),
          ] as const),
        ));
      });
      return;
    }
    if (this.context.containsAsyncSuspension(expr)) {
      this.context.unsupported("nested async value in the Rust state-machine subset", expr.loc);
    }
    const value = this.context.nextName("sc_async_value");
    this.context.line(`let ${value} = ${this.context.emitExpr(expr)};`);
    consume(value);
  }

  emitAsyncRecord(
    expr: Extract<IrExpr, { kind: "recordLit" }>,
    consume: (value: string) => void,
    index = 0,
    values = new Map<string, string>(),
    overflowValues: readonly (readonly [string, string])[] = [],
  ): void {
    if (expr.type.kind !== "record") this.context.unsupported("async record literal with a non-record type", expr.loc);
    const shape = this.context.records.get(expr.type.shapeId);
    if (shape === undefined) this.context.unsupported(`unknown record shape '${expr.type.shapeId}'`, expr.loc);
    const entry = expr.fields[index];
    if (entry !== undefined) {
      this.emitAsyncValue(entry.value, (value) => {
        const next = new Map(values);
        if (!entry.overflow && !entry.drop) next.set(entry.name, value);
        const overflow = entry.overflow ? [...overflowValues, [entry.name, value] as const] : overflowValues;
        this.emitAsyncRecord(expr, consume, index + 1, next, overflow);
      });
      return;
    }
    if (shape.indexValue !== undefined && shape.fields.length === 0) {
      const map = this.context.nextName("sc_async_record");
      const valueType = this.context.rustType(shape.indexValue, expr.loc);
      const entries = overflowValues.map(([name, value]) =>
        `runtime::map_set_by(&${map}, runtime::string("${this.context.rustString(name)}"), ${value}, |left, right| left.as_ref() == right.as_ref());`
      ).join(" ");
      consume(`{ let ${map}: runtime::JsMap<runtime::JsString, ${valueType}> = runtime::map_new(); ${entries} ${map} }`);
      return;
    }
    const fields = shape.fields.map((field) => {
      const value = values.get(field.name);
      if (value === undefined) this.context.unsupported(`missing async record field '${shape.id}.${field.name}'`, expr.loc);
      return `${mangleField(field.name)}: ${this.context.isEdgeValue(field.type) ? `Some(${value})` : value}`;
    }).join(", ");
    if (shape.indexValue === undefined) {
      consume(`runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} })`);
      return;
    }
    const map = this.context.nextName("sc_async_record");
    const valueType = this.context.rustType(shape.indexValue, expr.loc);
    const entries = overflowValues.map(([name, value]) =>
      `runtime::map_set_by(&${map}, runtime::string("${this.context.rustString(name)}"), ${value}, |left, right| left.as_ref() == right.as_ref());`
    ).join(" ");
    consume(`{ let ${map}: runtime::JsMap<runtime::JsString, ${valueType}> = runtime::map_new(); ${entries} runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields}, ${RUST_RECORD_OVERFLOW}: Some(${map}) }) }`);
  }

  recordCloneShape(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
  ): IrRecordShape {
    if (expr.type.kind !== "record") {
      this.context.unsupported("recordClone with a non-record type", expr.loc);
    }
    const shape = this.context.records.get(expr.type.shapeId);
    if (shape === undefined) {
      this.context.unsupported(`unknown record clone shape '${expr.type.shapeId}'`, expr.loc);
    }
    if (shape.tuple || shape.indexValue !== undefined || shapeHasAccessorSlots(shape)) {
      this.context.unsupported(`recordClone of non-plain shape '${shape.id}'`, expr.loc);
    }
    return shape;
  }

  emitRecordCloneInitial(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    source: string,
  ): string {
    const shape = this.recordCloneShape(expr);
    const fields = shape.fields.map((field) => {
      const access = `record.${mangleField(field.name)}`;
      const value = this.context.isEdgeValue(field.type) || this.context.needsClone(field.type)
        ? `${access}.clone()`
        : access;
      return `${mangleField(field.name)}: ${value}`;
    }).join(", ");
    return `${source}.with(|record| runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} }))`;
  }

  emitRecordCloneOverride(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    clone: string,
    fieldName: string,
    value: string,
  ): string {
    const shape = this.recordCloneShape(expr);
    const field = shape.fields.find((candidate) => candidate.name === fieldName);
    if (field === undefined) {
      this.context.unsupported(`unknown record clone field '${shape.id}.${fieldName}'`, expr.loc);
    }
    const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
    return `${clone}.with_mut(|record| record.${mangleField(field.name)} = ${stored});`;
  }

  emitAsyncRecordCloneOverrides(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    clone: string,
    consume: () => void,
    index = 0,
  ): void {
    const override = expr.overrides[index];
    if (override === undefined) {
      consume();
      return;
    }
    this.emitAsyncValue(override.value, (value) => {
      this.context.line(this.emitRecordCloneOverride(expr, clone, override.name, value));
      this.emitAsyncRecordCloneOverrides(expr, clone, consume, index + 1);
    });
  }

  emitAsyncProtectedRecordCloneOverrides(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    clone: string,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: () => void,
    index = 0,
  ): void {
    const override = expr.overrides[index];
    if (override === undefined) {
      consume();
      return;
    }
    this.context.emitAsyncProtectedValue(override.value, exitLocals, handlers, (value) => {
      this.context.line(this.emitRecordCloneOverride(expr, clone, override.name, value));
      this.emitAsyncProtectedRecordCloneOverrides(
        expr,
        clone,
        exitLocals,
        handlers,
        consume,
        index + 1,
      );
    });
  }

  emitAsyncValues(
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

  emitAsyncProtectedValues(
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
    this.context.emitAsyncProtectedValue(expr, exitLocals, handlers, (value) => {
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

  emitAsyncConsole(
    expr: Extract<IrExpr, { kind: "intrinsic" }>,
    remaining: readonly IrStmt[],
    index = 0,
    values: { name: string; type: IrType; loc: SrcLoc }[] = [],
    onComplete: (() => void) | null = null,
  ): void {
    const arg = expr.args[index];
    if (arg === undefined) {
      const method = expr.name === "console.log" ? "console_log" : "console_error";
      this.context.line(`runtime::${method}(&[${values.map((value) =>
        this.context.displayValue(value.name, value.type, value.loc)).join(", ")}]);`);
      this.context.emitAsyncStatements(remaining, onComplete);
      return;
    }
    if (this.context.containsAsyncSuspension(arg)) {
      this.emitAsyncValue(
        arg,
        (value) => this.emitAsyncConsole(expr, remaining, index + 1, [
          ...values,
          { name: value, type: arg.type, loc: arg.loc },
        ], onComplete),
      );
      return;
    }
    const value = this.context.nextName("sc_async_argument");
    this.context.line(`let ${value} = ${this.context.emitExpr(arg)};`);
    this.emitAsyncConsole(
      expr,
      remaining,
      index + 1,
      [...values, { name: value, type: arg.type, loc: arg.loc }],
      onComplete,
    );
  }

  emitAsyncContinuation(
    dependencyExpr: string,
    consume: (value: string) => void,
    remaining: readonly IrStmt[] | null,
    onComplete: (() => void) | null = null,
  ): void {
    const result = this.context.currentAsyncResult();
    if (result === null) this.context.unsupported("async continuation without a result promise", this.context.currentFunction()?.loc);
    const dependency = this.context.nextName("sc_async_dependency");
    const nextResult = this.context.nextName("sc_async_result");
    const outcome = this.context.nextName("sc_async_outcome");
    const guard = this.context.nextName("sc_async_guard");
    const value = this.context.nextName("sc_async_value");
    this.context.line(`let ${dependency} = ${dependencyExpr};`);
    this.context.line(`let ${nextResult} = ${result}.clone();`);
    this.context.line(`runtime::promise_then(&${dependency}, Box::new(move |${outcome}| {`);
    this.context.pushIndent();
    this.context.line(`let ${guard} = ${nextResult}.clone();`);
    this.context.line(`runtime::promise_run_segment(&${guard}, move || {`);
    this.context.pushIndent();
    this.context.line(`let ${result} = ${nextResult};`);
    this.context.line(`let ${value} = runtime::promise_unwrap(${outcome});`);
    consume(value);
    if (remaining !== null) this.context.emitAsyncStatements(remaining, onComplete);
    this.context.popIndent();
    this.context.line("});");
    this.context.popIndent();
    this.context.line("}));");
    this.context.line("return;");
  }

}
