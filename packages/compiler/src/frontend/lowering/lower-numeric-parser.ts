import { DYN, F64, STRING, isUnitType, typeKey, type IrExpr, type IrType } from "../../ir/nodes.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import { droppableStatic } from "./lower-exprs.js";
import { lowerNumberConversion } from "./lower-number-conversion.js";

function parserString(L: Lowerer, value: IrExpr): IrExpr | null {
  const loc = value.loc;
  const primitive = (type: IrType): boolean => isUnitType(type) ||
    type.kind === "string" || type.kind === "bool" || type.kind === "f64";
  if (value.type.kind === "void" || isUnitType(value.type)) {
    const result: IrExpr = {
      kind: "strLit", value: value.type.kind === "nullT" ? "null" : "undefined", type: STRING, loc,
    };
    return droppableStatic(value) ? result : {
      kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }], result, type: STRING, loc,
    };
  }
  const supported = value.type.kind === "union"
    ? L.unions.get(value.type.unionId)?.arms.every(primitive) === true : primitive(value.type);
  if (supported) return value.type.kind === "string" ? value : { kind: "toString", operand: value, type: STRING, loc };
  const dynamic = value.type.kind === "dyn" ? value
    : L.dynConvertible(value.type) ? L.coerceToExpected(value, DYN) : null;
  return dynamic === null ? null : { kind: "libCall", fn: "dyn.toStringCoerce", args: [dynamic], type: STRING, loc };
}

/** Evaluate all call arguments before ToString(source), then ToNumber(radix).
 * The helper preserves hook ordering and makes each input single-shot even
 * when an argument suspends. Primitive-only conversion needs no helper. */
export function lowerNumericParser(
  L: Lowerer, parser: "parseInt" | "parseFloat", value: IrExpr, radix?: IrExpr,
): IrExpr | null {
  const loc = value.loc;
  // Hidden helper parameters need materialized values, including an explicit
  // undefined/null radix and a void call whose side effects still execute.
  if (radix && isUnitType(radix.type)) radix = L.coerceToExpected(radix, DYN);
  else if (radix?.type.kind === "void") radix = {
    kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: radix, loc: radix.loc }],
    result: dynUndefinedExpr(radix.loc), type: DYN, loc: radix.loc,
  };
  const text = parserString(L, value);
  const numericRadix: IrExpr | null = radix ? lowerNumberConversion(L, radix) : { kind: "numLit" as const, value: 0, type: F64, loc };
  if (!text || (parser === "parseInt" && !numericRadix)) return null;
  if (parser === "parseFloat") return { kind: "libCall", fn: "num.parseFloat", args: [text], type: F64, loc };
  if (!numericRadix) return null;
  if (!radix || text.kind !== "libCall" || text.fn !== "dyn.toStringCoerce") {
    return { kind: "libCall", fn: "num.parseInt", args: [text, numericRadix], type: F64, loc };
  }
  const key = `parseInt.coercion:${typeKey(value.type)}:${typeKey(radix.type)}`;
  let name = L.widthHelpers.get(key);
  if (!name) {
    name = `%parseInt.coercion.${L.widthHelpers.size}`;
    const source: IrExpr = { kind: "varRef", localId: "source.0", type: value.type, loc };
    const base: IrExpr = { kind: "varRef", localId: "radix.0", type: radix.type, loc };
    const string = parserString(L, source);
    const number = lowerNumberConversion(L, base);
    if (!string || !number) return null;
    L.widthHelpers.set(key, name);
    L.liftedFns.push({
      name, params: [{ localId: "source.0", name: "source", type: value.type }, { localId: "radix.0", name: "radix", type: radix.type }],
      locals: [{ id: "source.0", name: "source", type: value.type, mutable: false }, { id: "radix.0", name: "radix", type: radix.type, mutable: false }],
      returnType: F64, body: [{ kind: "return", value: { kind: "libCall", fn: "num.parseInt", args: [string, number], type: F64, loc }, loc }], loc,
    });
  }
  return { kind: "call", callee: name, args: [value, radix], type: F64, loc };
}
