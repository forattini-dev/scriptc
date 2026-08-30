import type { IrType } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { RustAsyncControlContext } from "./async-control.js";
import type { IrAwaitExpr } from "./model.js";

/** Build the promise dependency selected by an await operand. A tagged
 * promise-or-plain value becomes one promise in every match arm, leaving
 * the continuation machinery oblivious to which spelling the hook used. */
export function emitAwaitDependency(
  context: RustAsyncControlContext,
  expr: IrAwaitExpr,
): string {
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
