import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, VOID, typeEquals, type IrExpr, type IrType, type IrStmt } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** JavaScript's inferred any[] constructor needs dynamic element storage,
 * not a numeric backing array that later rejects string writes. */
export function lowerDynamicArrayConstructor(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.NewExpression,
  args: readonly ts.Expression[],
  mapped: IrType | null,
): IrExpr | null {
  if (!lowerer.nativeDenseArrays || (!isJsSourceFile(expr.getSourceFile()) && mapped?.kind !== "dyn")) return null;
  if (mapped?.kind === "array") {
    const element = mapped.elem;
    // JS permits heterogeneous arguments even when the ambient overload
    // inferred its element type from just one argument.
    if (args.length < 2 || args.every(arg => {
      const actual = lowerer.mapTypeOf(lowerer.typeOf(arg));
      return actual !== null && (typeEquals(actual, element) ||
        (element.kind === "union" && lowerer.armTag(element.unionId, actual) >= 0));
    })) return null;
  } else if ((mapped !== null && mapped.kind !== "dyn") || !lowerer.checker.isArrayType(lowerer.typeOf(expr))) {
    return null;
  }
  const loc = locOf(expr);
  const elements = args.map(arg => lowerer.lowerExprExpecting(arg, DYN));
  const sole = elements[0];
  if (elements.length !== 1 || sole === undefined) return { kind: "dynArrLit", elems: elements, type: DYN, loc };
  const input = lowerer.declareHiddenLocal("%dynamicArrayArgument", DYN);
  const argument = varRef(input.id, DYN, loc);
  const local = lowerer.declareHiddenLocal("%dynamicArrayConstructor", DYN);
  const array = varRef(local.id, DYN, loc);
  const set = (key: string): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "libCall", fn: "dyn.keySet",
      args: [array, { kind: "strLit", value: key, type: STRING, loc }, argument],
      type: VOID, loc,
    },
    loc,
  });
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: input.id, init: sole, loc },
      { kind: "varDecl", localId: local.id, init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc },
      {
        kind: "if", cond: { kind: "dynTest", test: "number", value: argument, type: BOOL, loc },
        then: [set("length")], else_: [set("0")],
        loc,
      },
    ],
    result: array, type: DYN, loc,
  };
}
