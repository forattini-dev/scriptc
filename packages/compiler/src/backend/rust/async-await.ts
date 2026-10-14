import type { IrExpr, IrType } from "../../ir/ir.js";
import { typeKey } from "../../ir/ir.js";
import type { RustAsyncControlContext } from "./async-control.js";
import { isRustAwaitExpr, type IrAwaitExpr } from "./model.js";

export function containsAsyncSuspension(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsAsyncSuspension);
  if (isRustAwaitExpr(value)) return true;
  const node = value as { kind?: unknown; fn?: unknown; name?: unknown };
  if (node.kind === "libCall" && node.fn === "async.hop") return true;
  if (node.kind === "intrinsic" && node.name === "module.await") return true;
  return Object.values(value).some(containsAsyncSuspension);
}

export function asyncAwaitedValue(context: RustAsyncControlContext, expr: IrExpr | null): {
  awaited: IrAwaitExpr; wrap: (value: string) => string;
} | null {
  if (isRustAwaitExpr(expr)) {
    const awaited = expr;
    return { awaited, wrap: value => awaited.kind === "awaitExpr" && awaited.adopt && awaited.type.kind === "void" ? `{ let _ = ${value}; }` : value };
  }
  if (expr?.kind !== "unionWrap") return null;
  const inner = asyncAwaitedValue(context, expr.value);
  if (inner === null) return null;
  const union = context.union(expr.unionId, expr.loc);
  const arm = union.arms[expr.tag];
  if (arm === undefined || context.isUnit(arm)) context.unsupported(`awaited union wrapper '${expr.unionId}:${expr.tag}'`, expr.loc);
  const variant = `${context.unionName(union.id)}::${context.unionVariant(expr.tag)}`;
  return { awaited: inner.awaited, wrap: value => `${variant}(${inner.wrap(value)})` };
}

/** Build the promise dependency selected by an await operand. A tagged
 * promise-or-plain value becomes one promise in every match arm, leaving
 * the continuation machinery oblivious to which spelling the hook used. */
export function emitAwaitDependency(
  context: RustAsyncControlContext,
  expr: IrAwaitExpr,
): string {
  if (expr.kind === "libCall") {
    const [value] = expr.args;
    if (expr.fn !== "async.awaitDyn" || expr.args.length !== 1 ||
        value?.type.kind !== "dyn" || expr.type.kind !== "dyn") {
      context.unsupported("dynamic await shape", expr.loc);
    }
    const dynamic = context.rustType(expr.type, expr.loc);
    const awaited = context.nextName("sc_async_await_dyn");
    return `{ let ${awaited} = ${context.emitExpr(value)}; match ${awaited} { ${dynamic}::Promise(handle) => runtime::promise_view_from_handle::<${dynamic}>(&handle), value => runtime::promise_resolved(value), } }`;
  }
  if (expr.kind === "awaitExpr") return context.emitExpr(expr.value);
  if (expr.value.type.kind !== "union") {
    context.unsupported("await union with a non-union operand", expr.loc);
  }
  const source = context.union(expr.value.type.unionId, expr.loc);
  const promiseArm = source.arms[expr.promiseTag];
  if (promiseArm?.kind !== "promise") {
    context.unsupported("await union without a Promise arm", expr.loc);
  }
  const sourceName = context.unionName(source.id);
  const value = context.nextName("sc_async_await_union");
  if (expr.type.kind === "void") {
    const arms = source.arms.map((arm, tag) => {
      const variant = `${sourceName}::${context.unionVariant(tag)}`;
      if (tag === expr.promiseTag) return `${variant}(promise) => promise`;
      if (context.isUnit(arm)) return `${variant} => runtime::promise_resolved(())`;
      context.unsupported(`await union arm '${arm.kind}'`, expr.loc);
    });
    return `{ let ${value} = ${context.emitExpr(expr.value)}; match ${value} { ${arms.join(", ")}, } }`;
  }
  if (typeKey(expr.type) === typeKey(promiseArm.inner)) {
    const result = expr.type.kind === "union" ? context.union(expr.type.unionId, expr.loc) : undefined;
    const arms = source.arms.map((arm, tag) => {
      const variant = `${sourceName}::${context.unionVariant(tag)}`;
      if (tag === expr.promiseTag) return `${variant}(promise) => promise`;
      if (typeKey(arm) === typeKey(expr.type)) {
        return `${variant}(value) => runtime::promise_resolved(value)`;
      }
      const resultTag = result?.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm)) ?? -1;
      if (result !== undefined && resultTag >= 0) {
        const target = `${context.unionName(result.id)}::${context.unionVariant(resultTag)}`;
        return context.isUnit(arm)
          ? `${variant} => runtime::promise_resolved(${target})`
          : `${variant}(value) => runtime::promise_resolved(${target}(value))`;
      }
      context.unsupported(`await union arm '${arm.kind}'`, expr.loc);
    });
    return `{ let ${value} = ${context.emitExpr(expr.value)}; match ${value} { ${arms.join(", ")}, } }`;
  }
  if (expr.type.kind !== "union") {
    context.unsupported("await union with a non-union result", expr.loc);
  }
  const result = context.union(expr.type.unionId, expr.loc);
  const resultName = context.unionName(result.id);
  const resultTag = (arm: IrType): number => {
    const tag = result.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
    if (tag < 0) context.unsupported(`await union result missing arm '${arm.kind}'`, expr.loc);
    return tag;
  };
  const arms = source.arms.map((arm, tag) => {
    const variant = `${sourceName}::${context.unionVariant(tag)}`;
    const resultArm = tag === expr.promiseTag ? promiseArm.inner : arm;
    const target = `${resultName}::${context.unionVariant(resultTag(resultArm))}`;
    if (tag === expr.promiseTag) {
      return `${variant}(promise) => runtime::promise_map(&promise, |value| ${target}(value))`;
    }
    if (context.isUnit(arm)) return `${variant} => runtime::promise_resolved(${target})`;
    context.unsupported(`await union arm '${arm.kind}'`, expr.loc);
  });
  return `{ let ${value} = ${context.emitExpr(expr.value)}; match ${value} { ${arms.join(", ")}, } }`;
}
