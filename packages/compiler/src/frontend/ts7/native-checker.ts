import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;
/** A source-built, version-pinned checker fixes tuple reference serialization.
 * Explicit/project-owned checkers retain their caller's precedence. */
export function patchedCheckerPath(): string | undefined {
  if (cached !== undefined) return cached;
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const manifestFile = join(pkg, "native-checker/manifest.json");
  if (!existsSync(manifestFile)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { commit: string; patch: string };
  const hash = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
  const patchHash = hash(readFileSync(join(pkg, "native-checker", manifest.patch)));
  const key = `${manifest.commit}-${patchHash.slice(0, 16)}`, platform = `${process.platform}-${process.arch}`;
  for (const directory of [join(pkg, "native-checker/bin", platform, key), join(pkg, "node_modules/.cache/scriptc-tsgo", key, platform)]) {
    const binary = join(directory, process.platform === "win32" ? "tsgo.exe" : "tsgo");
    const receipt = join(directory, "build.json");
    if (!existsSync(binary) || !existsSync(receipt)) continue;
    const built = JSON.parse(readFileSync(receipt, "utf8")) as { commit: string; patchHash: string; binaryHash: string; libraries: { name: string; hash: string }[] };
    if (built.commit !== manifest.commit || built.patchHash !== patchHash || built.binaryHash !== hash(readFileSync(binary)) ||
        !built.libraries.every(lib => existsSync(join(directory, lib.name)) && hash(readFileSync(join(directory, lib.name))) === lib.hash)) continue;
    cached = binary;
    return binary;
  }
  return undefined;
}
