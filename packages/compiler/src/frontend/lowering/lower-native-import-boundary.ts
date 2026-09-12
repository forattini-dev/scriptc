import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { nativeImportHandleType } from "./lower-native-import-types.js";

/** Keep source provenance through expression lowering, including casts.
 * The Rust handle itself is shared; converting it to a checker record would
 * take a snapshot and discard the namespace's live binding semantics. */
export function noteNativeImportSource(L: Lowerer, node: ts.Expression, value: IrExpr): IrExpr {
  if (!["jsval", "dyn", "promise"].includes(value.type.kind)) return value;
  if (nativeImportHandleType(L, node)) L.nativeImportSources.set(value, node);
  return value;
}

export function rejectNativeImportCopy(L: Lowerer, value: IrExpr, expected: IrType): void {
  const node = L.nativeImportSources.get(value);
  if (!node) return;
  const copies = (type: IrType): boolean => {
    if (type.kind === "promise") return copies(type.inner);
    if (type.kind === "union") return L.unions.get(type.unionId)?.arms.some(copies) ?? true;
    return !["jsval", "dyn", "f64", "bool", "string", "void", "nullT", "undefinedT"].includes(type.kind);
  };
  if (copies(expected)) {
    L.unsupported("SC1090", node,
      "native module namespace conversion to a typed value that copies exports (keep the namespace handle or read individual exports)");
  }
}

/** Type assertions do not replace a module object in JavaScript. Keep the
 * handle here; subsequent typed slots still pass the no-copy boundary. */
export function lowerNativeImportAssertion(L: Lowerer, node: ts.AsExpression | ts.TypeAssertion): IrExpr | null {
  return nativeImportHandleType(L, node.expression) ? L.lowerExpr(node.expression) : null;
}
