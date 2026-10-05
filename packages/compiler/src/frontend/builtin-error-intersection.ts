import { RUNTIME_ERROR_CLASSES, type IrType } from "../ir/ir.js";

/** A standard Error ancestor adds no layout to its descendant. Admit only
 * already provenance-checked builtin Error types, never arbitrary record
 * refinements or intersections between sibling runtime error classes. */
export function builtinErrorIntersection(parts: readonly (IrType | null)[]): IrType | null {
  let result: string | null = null;
  const descendsFrom = (child: string, ancestor: string): boolean => {
    for (let current: string | null = child; current !== null; current = RUNTIME_ERROR_CLASSES.get(current)?.base ?? null) {
      if (current === ancestor) return true;
    }
    return false;
  };
  for (const part of parts) {
    if (part?.kind !== "object" || !RUNTIME_ERROR_CLASSES.has(part.className)) return null;
    if (result === null || descendsFrom(part.className, result)) result = part.className;
    else if (!descendsFrom(result, part.className)) return null;
  }
  return result === null ? null : { kind: "object", className: result };
}
