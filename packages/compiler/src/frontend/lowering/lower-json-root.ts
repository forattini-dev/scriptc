import { isJsonStringifyType } from "../../ir/json-stringify.js";
import { BOOL, DYN, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { InternalCompilerError } from "../../errors.js";
import type { Lowerer } from "./lowerer.js";

function undefinedJsonResult(L: Lowerer, loc: SrcLoc): IrExpr {
  const missing = L.wrappedUndefined(L.withUndefinedArm(STRING), loc);
  if (!missing) throw new InternalCompilerError("optional JSON root result needs an undefined arm");
  return missing;
}

/** Serialize each present arm at its concrete type; the missing arm remains
 * undefined. A helper evaluates both the root and runtime spacing only once. */
export function lowerNativeOptionalJsonRoot(L: Lowerer, value: IrExpr, indent: string, space: IrExpr | null, loc: SrcLoc): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const def = L.unions.get(unionId);
  const undefinedTag = def?.arms.findIndex(arm => arm.kind === "undefinedT") ?? -1;
  if (!def || undefinedTag < 0 || !def.arms.every(arm => arm.kind === "undefinedT" || isJsonStringifyType(arm, id => L.shapes.get(id), id => L.unions.get(id)))) return null;
  const resultType = L.withUndefinedArm(STRING);
  const key = `json.optionalRoot:${unionId}:${JSON.stringify(indent)}:${space !== null}`;
  let helper = L.widthHelpers.get(key);
  if (!helper) {
    helper = `%json.optionalRoot.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, helper);
    const input = varRef("value.0", value.type, loc);
    const missing = undefinedJsonResult(L, loc);
    const body: IrStmt[] = [{
      kind: "if", cond: { kind: "unionIsTag", unionId, tag: undefinedTag, negated: false, value: input, type: BOOL, loc },
      then: [{ kind: "return", value: missing, loc }], else_: null, loc,
    }];
    const presentArms = def.arms.map((arm, tag) => ({ arm, tag })).filter(({ tag }) => tag !== undefinedTag);
    for (const [index, { arm, tag }] of presentArms.entries()) {
      const serialized: IrExpr = arm.kind === "nullT" ? { kind: "strLit", value: "null", type: STRING, loc } : {
        kind: "jsonStringify", value: { kind: "unionNarrow", unionId, tag, value: input, type: arm, loc }, type: STRING, loc,
      };
      if (serialized.kind === "jsonStringify") {
        if (indent !== "") (serialized as IrExpr & { indent?: string }).indent = indent;
        if (space !== null) (serialized as IrExpr & { runtimeIndent?: IrExpr }).runtimeIndent = varRef("space.1", DYN, loc);
      }
      const result: IrStmt = { kind: "return", value: L.coerceToExpected(serialized, resultType), loc };
      body.push(index === presentArms.length - 1 ? result : {
        kind: "if", cond: { kind: "unionIsTag", unionId, tag, negated: false, value: input, type: BOOL, loc },
        then: [result], else_: null, loc,
      });
    }
    L.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: value.type }, ...(space === null ? [] : [{ localId: "space.1", name: "space", type: DYN }])],
      returnType: resultType,
      locals: [{ id: "value.0", name: "value", type: value.type, mutable: false }, ...(space === null ? [] : [{ id: "space.1", name: "space", type: DYN, mutable: false }])],
      body, loc,
    });
  }
  return { kind: "call", callee: helper, args: space === null ? [value] : [value, space], type: resultType, loc };
}

export function lowerUnitJsonRoot(L: Lowerer, value: IrExpr | null, space: IrExpr | null, loc: SrcLoc, unit: "undefined" | "null" = "undefined"): IrExpr {
  const result: IrExpr = unit === "undefined"
    ? undefinedJsonResult(L, loc)
    : { kind: "strLit", value: "null", type: STRING, loc };
  const args = [value, space].filter((arg): arg is IrExpr => arg !== null && arg.kind !== "unitLit");
  return args.length === 0 ? result : {
    kind: "seqExpr", stmts: args.map(expr => ({ kind: "exprStmt", expr, loc: expr.loc })), result, type: result.type, loc,
  };
}
