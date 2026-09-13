import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { BOOL, F64, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { BIGINT_LIB_FN_SIGS, type IrBigIntLibFn } from "../../ir/bigint-signatures.js";

function lib(fn: IrBigIntLibFn, args: IrExpr[], loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn, args, type: BIGINT_LIB_FN_SIGS[fn].result, loc };
}
function isBigInt(L: Lowerer, node: ts.Expression): boolean { return L.mapTypeOf(L.typeOf(node))?.kind === "bigint"; }

const binary: Partial<Record<ts.SyntaxKind, IrBigIntLibFn>> = {
  [ts.SyntaxKind.PlusToken]: "bigint.add", [ts.SyntaxKind.MinusToken]: "bigint.sub",
  [ts.SyntaxKind.AsteriskToken]: "bigint.mul", [ts.SyntaxKind.SlashToken]: "bigint.div",
  [ts.SyntaxKind.PercentToken]: "bigint.rem", [ts.SyntaxKind.AsteriskAsteriskToken]: "bigint.pow",
  [ts.SyntaxKind.AmpersandToken]: "bigint.and", [ts.SyntaxKind.BarToken]: "bigint.or",
  [ts.SyntaxKind.CaretToken]: "bigint.xor", [ts.SyntaxKind.LessThanLessThanToken]: "bigint.shl",
  [ts.SyntaxKind.GreaterThanGreaterThanToken]: "bigint.shr",
};
const comparisons: Partial<Record<ts.SyntaxKind, "<" | ">" | "<=" | ">=" | "===" | "!==">> = {
  [ts.SyntaxKind.LessThanToken]: "<", [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=", [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsToken]: "!==",
};

/** These operations retain typed BigInt values all the way to the Rust ABI. */
export function lowerBigIntExpression(L: Lowerer, expr: ts.Expression): IrExpr | null {
  const loc = locOf(expr);
  if (ts.isBigIntLiteral(expr)) {
    const value = expr.getText().replaceAll("_", "").slice(0, -1);
    return lib("bigint.fromString", [{ kind: "strLit", value, type: STRING, loc }], loc);
  }
  if (ts.isPrefixUnaryExpression(expr) && isBigInt(L, expr.operand)) {
    const fn = expr.operator === ts.SyntaxKind.MinusToken ? "bigint.neg"
      : expr.operator === ts.SyntaxKind.TildeToken ? "bigint.not" : null;
    if (fn) return lib(fn, [L.lowerExpr(expr.operand)], loc);
  }
  if (ts.isTypeOfExpression(expr) && isBigInt(L, expr.expression)) {
    const result: IrExpr = { kind: "strLit", value: "bigint", type: STRING, loc };
    return { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: L.lowerExpr(expr.expression), loc }], result, type: STRING, loc };
  }
  if (ts.isCallExpression(expr)) return lowerBigIntCall(L, expr);
  if (!ts.isBinaryExpression(expr)) return null;
  const operation = binary[expr.operatorToken.kind];
  const comparison = comparisons[expr.operatorToken.kind];
  if (!operation && !comparison) return null;
  const leftBig = isBigInt(L, expr.left), rightBig = isBigInt(L, expr.right);
  if (!leftBig && !rightBig) return null;
  // Union and dynamic values require their ordinary tag/boundary checks.
  // Their runtime kind cannot be disproved from this static classification.
  if (comparison && [expr.left, expr.right].some(node => ["union", "dyn", "jsval", "caught"].includes(L.mapTypeOf(L.typeOf(node))?.kind ?? ""))) return null;
  const left = L.lowerExpr(expr.left), right = L.lowerExpr(expr.right);
  if (operation && leftBig && rightBig) return lib(operation, [left, right], loc);
  if (operation === "bigint.add" && (left.type.kind === "string" || right.type.kind === "string")) {
    return { kind: "strConcat", left: leftBig ? lib("bigint.toString", [left], loc) : left,
      right: rightBig ? lib("bigint.toString", [right], loc) : right, type: STRING, loc };
  }
  if (!comparison) return L.unsupported("SC1090", expr, "mixed BigInt arithmetic");
  const stmts: IrStmt[] = [];
  const bind = (value: IrExpr): IrExpr => {
    const local = L.declareHiddenLocal("%bigintOperand", value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return { kind: "varRef", localId: local.id, type: value.type, loc };
  };
  const values: [IrExpr, IrExpr] = [bind(left), bind(right)];
  let result: IrExpr;
  if (leftBig !== rightBig && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(expr.operatorToken.kind)) {
    result = { kind: "boolLit", value: comparison === "!==", type: BOOL, loc };
  } else {
    const other = leftBig ? right : left;
    if (!(leftBig && rightBig) && other.type.kind !== "f64") return L.unsupported("SC1090", expr, "this mixed BigInt comparison");
    const compare = leftBig && rightBig ? lib("bigint.cmp", values, loc)
      : lib("bigint.cmpNumber", leftBig ? values : [values[1], values[0]], loc);
    const op = !leftBig && rightBig ? ({ "<": ">", ">": "<", "<=": ">=", ">=": "<=", "===": "===", "!==": "!==" } as const)[comparison] : comparison;
    result = { kind: "bin", op, left: compare, right: { kind: "numLit", value: 0, type: F64, loc }, type: BOOL, loc };
  }
  return { kind: "seqExpr", stmts, result, type: BOOL, loc };
}

function lowerBigIntCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const loc = locOf(expr), callee = expr.expression;
  const argument = expr.arguments[0];
  if (argument && expr.arguments.length === 1) {
    for (const name of ["BigInt", "String", "Number", "Boolean"]) {
      if (!L.isStdlibGlobal(callee, name)) continue;
      if (name !== "BigInt" && !isBigInt(L, argument)) return null;
      const value = L.lowerExpr(argument);
      // DataView's composed Number(getBig*64(...)) intrinsic already
      // performs the integer-to-double conversion, including rounding.
      if (name === "Number" && value.kind === "bytesIntrinsic" &&
          (value.method === "dvGetBigUint64Number" || value.method === "dvGetBigInt64Number")) return value;
      if (name === "BigInt") {
        if (value.type.kind === "bigint") return value;
        const fn = value.type.kind === "string" ? "bigint.fromString" : value.type.kind === "f64" ? "bigint.fromNumber" : value.type.kind === "bool" ? "bigint.fromBool" : null;
        if (fn) return lib(fn, [value], loc);
      } else return lib(name === "String" ? "bigint.toString" : name === "Number" ? "bigint.toNumber" : "bigint.truthy", [value], loc);
    }
  }
  if (ts.isPropertyAccessExpression(callee)) {
    if (L.isStdlibGlobal(callee.expression, "BigInt") && expr.arguments.length === 2 && ["asIntN", "asUintN"].includes(callee.name.text)) {
      return lib(callee.name.text === "asIntN" ? "bigint.asIntN" : "bigint.asUintN", expr.arguments.map(a => L.lowerExpr(a)), loc);
    }
    if (callee.name.text === "toString" && expr.arguments.length <= 1 && isBigInt(L, callee.expression)) {
      const value = L.lowerExpr(callee.expression);
      return argument ? lib("bigint.radix", [value, L.lowerExpr(argument)], loc) : lib("bigint.toString", [value], loc);
    }
  }
  return null;
}
