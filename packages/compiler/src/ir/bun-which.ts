import { STRING, VOID, type IrExpr, type IrType, type IrUnionDef, type SrcLoc } from "./ir.js";

export const BUN_WHICH_SIG = { argTypes: [STRING, null, null], result: VOID };

/** Site-interned unions: (string, string | undefined, string | undefined) → string | null. */
export function validateBunWhich(
  expr: Extract<IrExpr, { kind: "libCall" }>,
  union: (id: string) => IrUnionDef | undefined,
  error: (message: string, loc: SrcLoc) => void,
): void {
  const pair = (type: IrType | undefined, unit: "undefinedT" | "nullT"): boolean => {
    const arms = type?.kind === "union" ? union(type.unionId)?.arms : undefined;
    return arms?.length === 2 && arms.some(arm => arm.kind === "string") && arms.some(arm => arm.kind === unit);
  };
  for (const index of [1, 2]) {
    if (!pair(expr.args[index]?.type, "undefinedT")) error(`libCall bun.which arg ${index} must be string | undefined`, expr.loc);
  }
  if (!pair(expr.type, "nullT")) error("libCall bun.which must return string | null", expr.loc);
}
