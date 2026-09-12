import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { nodeThrowExpr, type Lowerer } from "./lowerer.js";
import { lowerDynObjectLiteral } from "./lower-exprs.js";

/** Error(message) and super(message) share ToString, except undefined is
 * the omitted-message case. The temporary keeps argument evaluation and
 * user coercion hooks single-shot. Only existing native dyn conversions
 * are admitted; unsupported carriers retain a compile-time fence. */
export function errorMessageArg(L: Lowerer, args: readonly ts.Expression[], loc: SrcLoc, blame: ts.Node): IrExpr {
  if (args.length > 1) L.unsupported("SC1090", args[1] ?? blame, "Error constructor options ('cause')");
  const empty: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const node = args[0];
  if (node === undefined) return empty;
  return coerceErrorMessage(L, lowerInput(L, node), node, loc);
}

function lowerInput(L: Lowerer, node: ts.Expression): IrExpr {
  return ts.isObjectLiteralExpression(node) ? lowerDynObjectLiteral(L, node) : L.lowerExpr(node);
}

function coerceErrorMessage(L: Lowerer, value: IrExpr, node: ts.Expression, loc: SrcLoc): IrExpr {
  const empty: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  if (value.type.kind === "string") return value;
  if (value.kind === "unitLit" && value.unit === "undefined") return empty;
  if (value.type.kind === "symbol") {
    return { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }],
      result: nodeThrowExpr(1, "", "Cannot convert a Symbol value to a string", STRING, loc), type: STRING, loc };
  }
  const dynamic: IrExpr | null = value.type.kind === "dyn" ? value
    : value.kind === "unitLit" || L.dynConvertible(value.type)
      ? { kind: "dynFrom", value, type: DYN, loc } : null;
  if (dynamic === null) L.unsupported("SC1090", node, `Error messages of type '${L.fmt(value.type)}' without a native ToString conversion`);
  const slot = L.declareHiddenLocal("%errorMessage", DYN);
  const ref: IrExpr = { kind: "varRef", localId: slot.id, type: DYN, loc };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: dynamic, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "dynTest", test: "undefined", value: ref, type: BOOL, loc },
      then: empty,
      else_: { kind: "libCall", fn: "dyn.toStringCoerce", args: [ref], type: STRING, loc },
      type: STRING, loc,
    },
    type: STRING, loc,
  };
}

/** The inline cause expression is an argument-evaluation effect. It runs
 * AFTER the message expression but BEFORE ToString inside the constructor,
 * even if conversion throws. Keep both values before normalizing either. */
export function errorWithCause(L: Lowerer, message: ts.Expression, cause: ts.Expression, className: string, loc: SrcLoc): IrExpr {
  const raw = lowerInput(L, message);
  const input: IrExpr = raw.kind === "unitLit" ? { kind: "dynFrom", value: raw, type: DYN, loc } : raw;
  const causeValue = L.lowerExpr(cause);
  const dynCause = L.coerceToExpected(causeValue, DYN);
  if (dynCause.type.kind !== "dyn") {
    L.noLowering(`Error cause of type '${L.fmt(causeValue.type)}'`, cause,
      "unknown and checked-dynamic-convertible cause values lower");
  }
  const inputSlot = L.declareHiddenLocal("%errorMessageArgument", input.type);
  const causeSlot = L.declareHiddenLocal("%errorCauseArgument", DYN);
  const inputRef: IrExpr = { kind: "varRef", localId: inputSlot.id, type: input.type, loc };
  const causeRef: IrExpr = { kind: "varRef", localId: causeSlot.id, type: DYN, loc };
  const result: IrExpr = { kind: "libCall", fn: "error.newCause",
    args: [coerceErrorMessage(L, inputRef, message, loc), causeRef], type: { kind: "object", className }, loc };
  return { kind: "seqExpr", stmts: [
    { kind: "varDecl", localId: inputSlot.id, init: input, loc },
    { kind: "varDecl", localId: causeSlot.id, init: dynCause, loc },
  ], result, type: result.type, loc };
}
