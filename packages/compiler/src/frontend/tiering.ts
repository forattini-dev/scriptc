/**
 * Module TIERS — the static frontier.
 *
 * Every program module is either STATIC (lowered to native code) or ISLAND
 * (embedded as JavaScript for the engine, exactly like an npm module, and
 * bound into static code through the same `island.import` handles npm
 * imports use). The classification is the compiler's progressive answer
 * to a program it cannot lower whole: the frontier moves module by module,
 * and the coverage report names every island module and why.
 *
 * Two classifications compose: EXPLICIT — `--island-module <glob>`
 * (repeatable) names island modules — and AUTOMATIC — `--island-module
 * auto` lets the compiler move a module whose lowering reports a blocker
 * into the island and lower again, to a fixpoint (index.ts's
 * lowerWithFrontier). Cascade markers (a use inheriting a declaration's
 * blocker, an import fence, an island-embedding refusal) never move a
 * module by themselves: the module owning the ROOT blocker does. Later
 * phases add pins and host modules (island → static edges).
 *
 * Globs match the module's absolute path; a relative glob resolves against
 * the ENTRY's package root (the nearest package.json directory above the
 * entry) and, failing that, against the working directory. `**` spans
 * directories, `*` and `?` stay within one segment. The entry itself is
 * never an island module.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ModuleTierRow {
  readonly module: string;
  readonly tier: "static" | "island";
  /** Why the module sits in its tier (`explicit` for --island-module). */
  readonly reason: string;
}

let patterns: readonly string[] = [];
let matchers: RegExp[] = [];
let entryFile: string | null = null;
let autoTiering = false;
/** The entry's package root — where scriptc.json lives. */
let projectRoot: string | null = null;
/** Modules pinned to the island by the project's scriptc.json. */
const pinned = new Map<string, string>();
/** Automatically classified modules → the blocker that sent them over. */
const automatic = new Map<string, string>();

function packageRootOf(dir: string): string {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

/** One glob → one anchored regular expression over a POSIX absolute path. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans zero or more directories; a trailing `**` spans the rest.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

/** Installs the explicit island-module globs for one compile. */
export function setIslandModules(globs: readonly string[], entryPath: string): void {
  entryFile = resolve(entryPath);
  automatic.clear();
  pinned.clear();
  projectRoot = packageRootOf(dirname(entryFile));
  const trimmed = globs.map((g) => g.trim()).filter((g) => g !== "");
  autoTiering = trimmed.includes("auto");
  patterns = trimmed.filter((g) => g !== "auto");
  // scriptc.json beside the entry's package.json: a persisted frontier
  // (`--write-tiers`) pins its island modules without a fixpoint.
  const config = readProjectTiers(projectRoot);
  for (const [file, reason] of config) pinned.set(file, reason);
  const roots = [projectRoot, dirname(entryFile), process.cwd()];
  matchers = patterns.flatMap((glob) => {
    const normalized = glob.replace(/\\/g, "/");
    if (isAbsolute(normalized)) return [globToRegExp(normalized)];
    // A relative glob anchors at each root; `./x` and `x` spell the same.
    const bare = normalized.replace(/^\.\//, "");
    return [...new Set(roots)].map((root) => globToRegExp(`${root.replace(/\\/g, "/")}/${bare}`));
  });
}

export function islandModulePatterns(): readonly string[] {
  const fromConfig = [...pinned.keys()].map((f) => `pinned:${f}`);
  return [...(autoTiering ? ["auto"] : []), ...patterns, ...fromConfig];
}

/** The project's persisted frontier: `{ "tiers": { "island": [{ "module":
 * "<path relative to the package root>", "reason": "…" }, …] } }`. Absent
 * or malformed = no pins. */
function readProjectTiers(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = join(root, "scriptc.json");
  if (!existsSync(file)) return out;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tiers?: { island?: unknown } };
    const island = parsed.tiers?.island;
    if (!Array.isArray(island)) return out;
    for (const row of island) {
      const module = typeof row === "string" ? row : (row as { module?: unknown })?.module;
      if (typeof module !== "string") continue;
      const reason = typeof row === "object" && row !== null && typeof (row as { reason?: unknown }).reason === "string"
        ? (row as { reason: string }).reason
        : "pinned";
      out.set(resolve(root, module).replace(/\\/g, "/"), `pinned (scriptc.json): ${reason}`);
    }
  } catch {
    /* an unreadable scriptc.json pins nothing */
  }
  return out;
}

/** Persists the current frontier — every automatically and pinned island
 * module — into the project's scriptc.json (module paths relative to the
 * package root, each with its reason), so later builds skip the fixpoint.
 * Explicit --island-module globs stay on the command line. Returns the
 * file written. */
export function writeProjectTiers(): string {
  if (projectRoot === null) throw new Error("no compile has selected an entry yet");
  const rows = [...automatic.entries(), ...pinned.entries()]
    .map(([file, reason]) => ({ module: relative(projectRoot!, file).replace(/\\/g, "/"), reason: reason.replace(/^pinned \(scriptc\.json\): /, "") }))
    .sort((a, b) => a.module.localeCompare(b.module));
  const file = join(projectRoot, "scriptc.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const next = { ...existing, tiers: { ...((existing["tiers"] as Record<string, unknown> | undefined) ?? {}), island: rows } };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}

/** `--island-module auto`: the lowering fixpoint may move modules. */
export function autoIslandTiering(): boolean {
  return autoTiering;
}

/** Records one automatically classified module and the root blocker that
 * sent it to the island (the first diagnostic in the module). */
export function addAutoIslandModule(fileName: string, reason: string): void {
  automatic.set(resolve(fileName).replace(/\\/g, "/"), reason);
}

/** Why a module is in the island: the explicit glob or the automatic
 * classification's blocker. Null for static modules. */
export function islandModuleReason(fileName: string): string | null {
  const normalized = resolve(fileName).replace(/\\/g, "/");
  const auto = automatic.get(normalized);
  if (auto !== undefined) return `auto: ${auto}`;
  const pin = pinned.get(normalized);
  if (pin !== undefined) return pin;
  return matchers.some((m) => m.test(normalized)) ? "explicit (--island-module)" : null;
}

/** True when `fileName` (absolute) is an island module under the explicit
 * classification. Cheap enough to call per import statement. */
export function isIslandModulePath(fileName: string): boolean {
  if (matchers.length === 0 && automatic.size === 0 && pinned.size === 0) return false;
  const normalized = resolve(fileName).replace(/\\/g, "/");
  if (entryFile !== null && normalized === entryFile.replace(/\\/g, "/")) return false;
  return automatic.has(normalized) || pinned.has(normalized) || matchers.some((m) => m.test(normalized));
}
