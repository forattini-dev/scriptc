import type { IrExpr, IrUnionDef, SrcLoc } from "./ir.js";

export function validateBunSpawn(expr: Extract<IrExpr, { kind: "libCall" }>, union: (id: string) => IrUnionDef | undefined, error: (message: string, loc: SrcLoc) => void): void {
  if (expr.fn === "bun.spawn") {
    for (const index of [1, 2, 3]) {
      const mode = expr.args[index];
      if (mode?.kind !== "numLit" || (mode.value !== 0 && mode.value !== 1 && !(index !== 1 && mode.value === 2))) error(`libCall bun.spawn arg ${index} must be a literal ignore/inherit mode or output pipe`, expr.loc);
    }
  }
  if (expr.fn === "bun.exitCode") {
    const arms = expr.type.kind === "union" ? union(expr.type.unionId)?.arms : undefined;
    if (arms?.length !== 2 || !arms.some(arm => arm.kind === "f64") || !arms.some(arm => arm.kind === "nullT")) error("libCall bun.exitCode must return number | null", expr.loc);
  }
}
