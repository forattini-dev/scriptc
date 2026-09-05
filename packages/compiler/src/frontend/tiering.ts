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
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
  const trimmed = globs.map((g) => g.trim()).filter((g) => g !== "");
  autoTiering = trimmed.includes("auto");
  patterns = trimmed.filter((g) => g !== "auto");
  const roots = [packageRootOf(dirname(entryFile)), dirname(entryFile), process.cwd()];
  matchers = patterns.flatMap((glob) => {
    const normalized = glob.replace(/\\/g, "/");
    if (isAbsolute(normalized)) return [globToRegExp(normalized)];
    // A relative glob anchors at each root; `./x` and `x` spell the same.
    const bare = normalized.replace(/^\.\//, "");
    return [...new Set(roots)].map((root) => globToRegExp(`${root.replace(/\\/g, "/")}/${bare}`));
  });
}

export function islandModulePatterns(): readonly string[] {
  return autoTiering ? ["auto", ...patterns] : patterns;
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
  return matchers.some((m) => m.test(normalized)) ? "explicit (--island-module)" : null;
}

/** True when `fileName` (absolute) is an island module under the explicit
 * classification. Cheap enough to call per import statement. */
export function isIslandModulePath(fileName: string): boolean {
  if (matchers.length === 0 && automatic.size === 0) return false;
  const normalized = resolve(fileName).replace(/\\/g, "/");
  if (entryFile !== null && normalized === entryFile.replace(/\\/g, "/")) return false;
  return automatic.has(normalized) || matchers.some((m) => m.test(normalized));
}
