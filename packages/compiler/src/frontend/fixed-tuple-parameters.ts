import * as ts from "./ts7/adapter.js";
import type { IrType } from "../ir/ir.js";

/** A finite tuple in a callable signature describes positional ABI slots.
 * Optional slots complete with undefined; this does not make an optional
 * tuple VALUE a fixed-length record or admit unbounded variadic tuples. */
export function fixedTupleParameters(
  type: ts.TupleTypeReference,
  checker: ts.TypeChecker,
  mapElement: (type: ts.Type) => IrType | null,
  armUndefined: (type: IrType) => IrType | null,
): IrType[] | null {
  const elements = checker.getTypeArguments(type);
  if (elements.length === 0) return [];
  const shape = type.elementFlags !== undefined ? type : type.getTarget() as ts.TupleType | undefined;
  const flags = shape?.elementFlags;
  if (flags === undefined || flags.length !== elements.length ||
      flags.some(flag => flag !== ts.ElementFlags.Required && flag !== ts.ElementFlags.Optional)) return null;
  const params: IrType[] = [];
  for (const [index, element] of elements.entries()) {
    let mapped = mapElement(element);
    if (mapped === null) return null;
    if (mapped.kind === "void") continue;
    if (flags[index] === ts.ElementFlags.Optional && mapped.kind !== "dyn" && mapped.kind !== "jsval") {
      mapped = armUndefined(mapped);
      if (mapped === null) return null;
    }
    params.push(mapped);
  }
  return params;
}
