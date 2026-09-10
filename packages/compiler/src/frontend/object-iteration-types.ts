import * as ts from "./ts7/adapter.js";
import { DYN, type IrType, typeKey } from "../ir/nodes.js";
import { mapType, type TypeMapperCtx } from "./types.js";
import { overridesDtsPath } from "./shared.js";

/** The intrinsic's conditional alias stays symbolic inside generic bodies.
 * Resolve it against this instantiation's record layouts, like T[keyof T]. */
export function mapObjectIterationValueAlias(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const alias = type.getAliasSymbol();
  if (alias?.name !== "ScriptcObjectValue" || !ctx.checker.declarationsOf(alias).some(
    declaration => ts.isTypeAliasDeclaration(declaration) && declaration.getSourceFile().fileName === overridesDtsPath(),
  )) return null;
  const args = type.getAliasTypeArguments();
  if (args.length !== 1 || args[0] === undefined) return null;
  const source = mapType(args[0], ctx);
  if (!source) return null;
  const values = new Map<string, IrType>();
  const collectValue = (value: IrType): void => {
    if (value.kind === "union") {
      for (const arm of ctx.unions.get(value.unionId)?.arms ?? []) collectValue(arm);
    } else values.set(typeKey(value), value);
  };
  const collectRecord = (record: IrType): boolean => {
    if (record.kind === "union") return ctx.unions.get(record.unionId)?.arms.every(collectRecord) ?? false;
    if (record.kind !== "record") return false;
    const shape = ctx.shapes.get(record.shapeId);
    if (!shape || shape.tuple) return false;
    if (shape.indexValue) collectValue(shape.indexValue);
    for (const field of shape.fields) collectValue(field.type);
    if (!shape.indexValue && shape.fields.length === 0) collectValue(DYN);
    return true;
  };
  if (!collectRecord(source) || values.size === 0) return null;
  if (values.has(typeKey(DYN))) return DYN;
  const arms = [...values.values()];
  return arms.length === 1 ? arms[0] ?? null : { kind: "union", unionId: ctx.unions.intern(arms) };
}
