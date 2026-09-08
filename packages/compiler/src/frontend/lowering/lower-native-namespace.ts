import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { DYN, type IrExpr } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";
import { nativeImportHandleType } from "./lower-native-import-types.js";

/** Namespace enumeration follows its live export table, even when the
 * checker presents a structurally representable record snapshot. */
export function lowerNativeNamespaceObjectWalk(L: Lowerer, call: ts.CallExpression,
  member: string): IrExpr | null {
  if (member !== "keys" && member !== "values" && member !== "entries") return null;
  const argument = call.arguments[0];
  if (call.arguments.length !== 1 || !argument || nativeImportHandleType(L, argument)?.kind !== "jsval") return null;
  const value = L.coerceToExpected(L.lowerExpr(argument), DYN);
  const fn = member === "keys" ? "dyn.objKeys" : member === "values" ? "dyn.objValues" : "dyn.objEntries";
  return { kind: "libCall", fn, args: [value], type: DYN, loc: locOf(call) };
}
