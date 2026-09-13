import { type IrExpr, type IrType, typeEquals, typeKey } from "../../ir/ir.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";

/** Representation conversion only: never resolve/adopt or schedule a job. */
export function promiseViewCoercible(L: Lowerer, from: IrType, to: IrType): boolean {
  return L.nativePromiseViews && from.kind === "promise" && to.kind === "promise" &&
    (to.inner.kind === "void" || (from.inner.kind === "void" && to.inner.kind === "dyn") || L.coercibleValue(from.inner, to.inner));
}

export function lowerPromiseView(L: Lowerer, value: IrExpr, target: IrType): IrExpr | null {
  const from = value.type;
  if (from.kind !== "promise" || target.kind !== "promise" || typeEquals(from, target) ||
      !promiseViewCoercible(L, from, target)) return null;
  const loc = value.loc;
  const key = `promise.view:${typeKey(from)}:${typeKey(target)}`;
  let name = L.retagHelpers.get(key);
  const type: IrType = { kind: "func", params: [from.inner], ret: target.inner };
  if (!name) {
    name = `%promise.view.${L.retagHelpers.size}`;
    L.retagHelpers.set(key, name);
    const input: IrExpr = { kind: "varRef", localId: "value.0", type: from.inner, loc };
    const result = target.inner.kind === "void" ? null : from.inner.kind === "void" && target.inner.kind === "dyn"
      ? dynUndefinedExpr(loc)
      : L.coerceToExpected(input, target.inner);
    L.liftedFns.push({ name, params: [{ localId: "value.0", name: "value", type: from.inner }],
      locals: [{ id: "value.0", name: "value", type: from.inner, mutable: false }], returnType: target.inner,
      body: [{ kind: "return", value: result, loc }], loc });
  }
  return { kind: "libCall", fn: "promise.view", args: [value, { kind: "closure", fnName: name, captures: [], type, loc }], type: target, loc };
}
