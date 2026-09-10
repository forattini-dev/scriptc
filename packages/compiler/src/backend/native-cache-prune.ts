import { readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

// Only these publishers stage active reads and use atomic private writes.
// Cargo target directories are mutable build transactions, not individual
// disposable artifacts: deleting their dependencies can break an active link
// and leave Cargo fingerprints claiming that absent outputs are still fresh.
// Unknown namespaces belong to their owner and must not enter this LRU budget.
const ARTIFACT_NAMESPACES = new Set([
  "bin", "lib", "obj", "meta", "local", "program-obj", "program-shard",
  "vendor", "oracle", "early-lib", "early-exe", "early-exe-route", "early-exe-implementation",
]);

/** Size-capped LRU sweep of scriptc-owned artifact namespaces. A caller-configured cap is
 * enforced after every successful cache write. The 4 GiB default is checked on
 * the first and every 64th write in a long-lived process: a full tree walk per
 * corpus program would otherwise become quadratic as the cache grows. Oldest-
 * mtime files go first until the tree is back under 75% of the cap; reads bump
 * mtimes. Active links use private staged names/hard links, so cache names can
 * be unlinked safely. */
const rootWriteCounts = new Map<string, number>();
export async function pruneCache(root: string, protectedPaths?: ReadonlySet<string>): Promise<void> {
  const configuredCap = process.env["SCRIPTC_CACHE_MAX_MB"];
  const writes = (rootWriteCounts.get(root) ?? 0) + 1;
  rootWriteCounts.set(root, writes);
  if (configuredCap === undefined && writes !== 1 && writes % 64 !== 0) return;
  const capBytes = Number(configuredCap ?? "4096") * 1024 * 1024;
  if (!Number.isFinite(capBytes) || capBytes <= 0) return;
  const cargoTarget = process.env["CARGO_TARGET_DIR"];
  const cargoTargetPath = cargoTarget === undefined ? undefined : resolve(cargoTarget);
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (dir === cargoTargetPath) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (dir === root && !ARTIFACT_NAMESPACES.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) {
        // Atomic publishers use private names until their data/digest or
        // metadata stamp is complete. They are active writes, not LRU entries.
        if (
          ent.name.startsWith(".scriptc-") ||
          ent.name.startsWith(".tmp-") ||
          ent.name.includes(".tmp-")
        ) continue;
        if (protectedPaths?.has(p)) continue;
        const s = await stat(p).catch(() => null);
        if (s !== null) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  await walk(root);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= capBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (total <= capBytes * 0.75) break;
    try {
      await unlink(f.path);
      total -= f.size;
    } catch {
      // A concurrent reader/publisher may already have moved the name.
    }
  }
}
