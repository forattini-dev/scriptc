import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { DATE_T, DYN, F64, isUnitType, typeKey, type IrExpr } from "../../ir/nodes.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import { lowerNumberConversion } from "./lower-number-conversion.js";

/** Read-only Date values retain a TimeClip'd millisecond scalar. Component
 * calls materialize ALL argument values before any observable ToNumber hook. */
export function lowerDateNew(L: Lowerer, expr: ts.NewExpression): IrExpr {
  const nodes = expr.arguments ?? [];
  const loc = locOf(expr);
  if (nodes.some(ts.isSpreadElement)) L.noLowering("new Date with spread arguments", expr);
  if (nodes.length === 0) return { kind: "libCall", fn: "date.newNow", args: [], type: DATE_T, loc };
  if (nodes.length === 1) {
    const arg = L.lowerExpr(nodes[0]!);
    if (arg.type.kind === "f64") return { kind: "libCall", fn: "date.newMs", args: [arg], type: DATE_T, loc };
    if (arg.type.kind === "string") return { kind: "libCall", fn: "date.newString", args: [arg], type: DATE_T, loc };
    if (arg.type.kind === "date") return arg;
    L.noLowering(`new Date of '${L.fmt(arg.type)}' values`, nodes[0]!, "pass milliseconds, a date string, or another Date value");
  }
  const args = nodes.map((node): IrExpr => {
    const value = L.lowerExpr(node);
    if (isUnitType(value.type)) return L.coerceToExpected(value, DYN);
    if (value.type.kind === "void") return {
      kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
      result: dynUndefinedExpr(value.loc), type: DYN, loc: value.loc,
    };
    return value;
  });
  const key = `date.components:${args.map((arg) => typeKey(arg.type)).join(":")}`;
  let name = L.widthHelpers.get(key);
  if (!name) {
    name = `%date.components.${L.widthHelpers.size}`;
    const params = args.map((arg, index) => ({ localId: `part.${index}`, name: `part${index}`, type: arg.type }));
    const defaults = [0, 0, 1, 0, 0, 0, 0];
    const numbers: IrExpr[] = defaults.map((value, index) => {
      const param = params[index];
      if (!param) return { kind: "numLit", value, type: F64, loc };
      const input: IrExpr = { kind: "varRef", localId: param.localId, type: param.type, loc };
      const number = lowerNumberConversion(L, input);
      if (!number) L.noLowering(`Date component of '${L.fmt(input.type)}' values`, nodes[index]!);
      return number;
    });
    L.widthHelpers.set(key, name);
    L.liftedFns.push({
      name, params, locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      returnType: DATE_T,
      body: [{ kind: "return", value: { kind: "libCall", fn: "date.newComponents", args: numbers, type: DATE_T, loc }, loc }], loc,
    });
  }
  return { kind: "call", callee: name, args, type: DATE_T, loc };
}
