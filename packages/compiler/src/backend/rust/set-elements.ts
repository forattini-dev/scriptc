import type { IrType, SrcLoc } from "../../ir/ir.js";

interface Context {
  mapKeyEquality(left: string, right: string, type: IrType, loc: SrcLoc): string;
  mapStoredKey(value: string, type: IrType): string;
  dynTypeName(): string;
}

export function setElementEquality(context: Context, left: string, right: string, type: IrType, loc: SrcLoc): string {
  const equal = context.mapKeyEquality(left, right, type, loc);
  if (type.kind !== "dyn") return equal;
  const dyn = context.dynTypeName();
  return `(${equal} || matches!((${left}, ${right}), (${dyn}::Number(a), ${dyn}::Number(b)) if a.is_nan() && b.is_nan()))`;
}

export function setStoredElement(context: Context, value: string, type: IrType): string {
  if (type.kind !== "dyn") return context.mapStoredKey(value, type);
  const dyn = context.dynTypeName();
  return `match ${value} { ${dyn}::Number(n) if n == 0.0 => ${dyn}::Number(0.0), value => value }`;
}
