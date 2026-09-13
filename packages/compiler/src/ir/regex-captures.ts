import { STRING, UNDEFINED_T, arrayOf, type IrType, type IrUnionDef } from "./ir.js";

export function isRegexCaptureRow(type: IrType, union: (id: string) => IrUnionDef | undefined): boolean {
  if (type.kind !== "array" || type.elem.kind !== "union") return false;
  const arms = union(type.elem.unionId)?.arms;
  return arms?.length === 2 && arms.some(arm => arm.kind === "string") && arms.some(arm => arm.kind === "undefinedT");
}

/** The standard library's string index signature omits absent captures. */
export function regexCaptureArray(unions: { intern(arms: IrType[]): string }): IrType {
  return arrayOf({ kind: "union", unionId: unions.intern([STRING, UNDEFINED_T]) });
}

export function regexCaptureLayout(type: IrType, union: (id: string) => IrUnionDef | undefined): {
  id: string; stringTag: number; undefinedTag: number;
} | null {
  const row = type.kind === "union"
    ? union(type.unionId)?.arms.find((arm) => arm.kind === "array")
    : type.kind === "array" ? type.elem : undefined;
  if (row?.kind !== "array" || row.elem.kind !== "union") return null;
  const def = union(row.elem.unionId);
  if (def?.arms.length !== 2) return null;
  const stringTag = def.arms.findIndex((arm) => arm.kind === "string");
  const undefinedTag = def.arms.findIndex((arm) => arm.kind === "undefinedT");
  return stringTag < 0 || undefinedTag < 0 ? null : { id: def.id, stringTag, undefinedTag };
}
