import { type IrExpr, type IrType, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Preserve the observable Proxy restriction of a fresh frozen literal.
 * The typed helper stays identity for ordinary static layouts; Rust's shared
 * representation records the restriction on the same underlying object. */
export function preserveNativeFreeze(L: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr {
  if (L.dynamic || value.type.kind !== "record") return value;
  const type: IrType = value.type;
  const key = `rec.proxyRestricted:${type.shapeId}`;
  let name = L.arrHofHelpers.get(key);
  if (!name) {
    name = `%rec.proxyRestricted.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    L.liftedFns.push({
      name, params: [{ localId: "value.0", name: "value", type }], returnType: type,
      locals: [{ id: "value.0", name: "value", type, mutable: false }],
      body: [{ kind: "return", value: { kind: "varRef", localId: "value.0", type, loc }, loc }], loc,
    });
  }
  return { kind: "call", callee: name, args: [value], type, loc };
}
