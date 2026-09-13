import { resolve } from "node:path";
import { tsgoPath } from "../dts-paths.js";

export function directExternalTypeSpecifiersByFile(
  externalTypes: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [specifier, file] of externalTypes) {
    const key = tsgoPath(resolve(file));
    const owners = out.get(key);
    if (owners === undefined) out.set(key, [specifier]);
    else if (!owners.includes(specifier)) owners.push(specifier);
  }
  return out;
}
