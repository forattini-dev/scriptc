import { InternalCompilerError } from "../../errors.js";
import { BOOL, DYN, F64, isUnitType, type IrExpr, type IrStmt, type IrType } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";
import { droppableStatic } from "./lower-exprs.js";

function primitiveNumber(value: IrExpr): IrExpr | null {
  const loc = value.loc;
  const number = (n: number): IrExpr => ({ kind: "numLit", value: n, type: F64, loc });
  switch (value.type.kind) {
    case "f64": return value;
    case "bool": return { kind: "ternary", cond: value, then: number(1), else_: number(0), type: F64, loc };
    case "string": return { kind: "libCall", fn: "num.fromString", args: [value], type: F64, loc };
    case "nullT":
    case "undefinedT":
    case "void": {
      const result = number(value.type.kind === "nullT" ? 0 : NaN);
      return droppableStatic(value) ? result : {
        kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }], result, type: F64, loc,
      };
    }
    default: return null;
  }
}

/** Native ToNumber for primitive unions. The helper takes the source once,
 * dispatches on its real tag, and retains StringToNumber's exact grammar.
 * Object coercion hooks and non-primitive numeric conversions remain separate. */
export function lowerNumberConversion(L: Lowerer, argument: IrExpr): IrExpr | null {
  if (argument.type.kind === "dyn") {
    return { kind: "libCall", fn: "dyn.toNumberCoerce", args: [argument], type: F64, loc: argument.loc };
  }
  if (argument.type.kind !== "union") {
    const primitive = primitiveNumber(argument);
    if (primitive) return primitive;
    if (L.dynConvertible(argument.type)) return lowerNumberConversion(L, L.coerceToExpected(argument, DYN));
    return null;
  }
  const type = argument.type;
  const definition = L.unions.get(type.unionId);
  const supported = (arm: IrType): boolean => isUnitType(arm) ||
    arm.kind === "f64" || arm.kind === "bool" || arm.kind === "string";
  if (!definition?.arms.length || !definition.arms.every(supported)) return null;
  const loc = argument.loc;
  const key = `number.primitive:${type.unionId}`;
  let name = L.widthHelpers.get(key);
  if (!name) {
    name = `%number.primitive.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const value: IrExpr = { kind: "varRef", localId: "value.0", type, loc };
    const body: IrStmt[] = definition.arms.map((arm, tag): IrStmt => {
      const payload: IrExpr = isUnitType(arm)
        ? { kind: "unitLit", unit: arm.kind === "nullT" ? "null" : "undefined", type: arm, loc }
        : { kind: "unionNarrow", unionId: type.unionId, tag, value, type: arm, loc };
      const converted = primitiveNumber(payload);
      if (!converted) throw new InternalCompilerError("supported primitive number arm did not lower");
      const returned: IrStmt = { kind: "return", value: converted, loc };
      return tag === definition.arms.length - 1 ? returned : {
        kind: "if",
        cond: { kind: "unionIsTag", unionId: type.unionId, tag, negated: false, value, type: BOOL, loc },
        then: [returned], else_: null, loc,
      };
    });
    L.liftedFns.push({
      name, params: [{ localId: "value.0", name: "value", type }],
      locals: [{ id: "value.0", name: "value", type, mutable: false }],
      returnType: F64, body, loc,
    });
  }
  return { kind: "call", callee: name, args: [argument], type: F64, loc };
}
