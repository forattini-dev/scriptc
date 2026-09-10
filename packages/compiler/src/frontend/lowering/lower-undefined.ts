import { UNDEFINED_T, type IrExpr, type IrType, type SrcLoc } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** The absent value of an undefined-armed union. This is also a speculative
 * eligibility check: declining must not synthesize coercion/trap helpers for
 * non-nullable slots, including generic methods resolved outside the record. */
export function wrappedUndefined(
  L: Pick<Lowerer, "armTag">, type: IrType, loc: SrcLoc,
): IrExpr | null {
  if (type.kind !== "union") return null;
  const tag = L.armTag(type.unionId, UNDEFINED_T);
  if (tag < 0) return null;
  const value: IrExpr = { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
  return { kind: "unionWrap", unionId: type.unionId, tag, value, type, loc };
}
