/**
 * The runtime TARGET a compiled program reproduces: `node24`, `node26`,
 * or `bun`. Where the Node matrix (node-matrix.ts) is the version axis
 * the compatibility profiles are censused against, this module is the
 * axis the COMPILER selects on — the ambient type surface, the runtime
 * export/imports conditions, the builtin-module table, the globals, and
 * the per-runtime semantic switches a binary carries.
 *
 * Everything here is DATA. The rule from the matrix applies unchanged: a
 * profile's identity fields (what `process.versions` and `process.release`
 * answer) come from running the census probe under that runtime, never
 * from a changelog; the `bun` profile's `semanticsNode` names the Node
 * build whose behavior the shared runtime kernels reproduce — the bun
 * target adds Bun's APIs, resolution, and identity on top of it, and the
 * `// @target bun` corpus programs are the byte-for-byte contract against
 * the pinned bun binary.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NODE24_TARGET_ID, NODE24_VERSION, NODE26_TARGET_ID, NODE26_VERSION } from "./node-matrix.js";

export type RuntimeTargetId = "node24" | "node26" | "bun";

export const RUNTIME_TARGET_IDS: readonly RuntimeTargetId[] = ["node24", "node26", "bun"];

/** The exact bun build the `bun` target is censused and oracled against
 * (the redcode workspace's `packageManager` pin). */
export const BUN_VERSION = "1.3.14";

export interface RuntimeTargetProfile {
  readonly id: RuntimeTargetId;
  readonly family: "node" | "bun";
  /** The Node build whose semantics the shared runtime reproduces. */
  readonly semanticsNode: string;
  readonly pins: { readonly node?: string; readonly bun?: string };
  /** Which ambient type package the program must resolve. */
  readonly typeSurface: "node" | "bun";
  /** Runtime export/imports conditions, in the runtime's own match order
   * (`types` joins for the checker; `import`/`default` are always on). */
  readonly conditions: readonly string[];
  /** Whether the `Bun` global exists in this runtime. */
  readonly bunGlobal: boolean;
  /** The per-runtime SEMANTIC switches a binary carries (the matrix
   * header's "semantics the primary decides" list, as data): */
  readonly features: {
    /** `Readable.prototype.read()` bare form, nodejs#60441: Node 24
     * collapses the whole paused queue, Node 26 hands back the head
     * chunk. */
    readonly readableBareRead: "collapse-queue" | "head-chunk";
  };
}

/** The IR-side spelling of a target: what the backends need to configure
 * the runtime, and nothing that would make the IR depend on this module. */
export interface RuntimeTargetIr {
  readonly id: RuntimeTargetId;
  readonly semanticsNode: string;
  readonly readableBareRead: "collapse-queue" | "head-chunk";
}

export function runtimeTargetIr(profile: RuntimeTargetProfile): RuntimeTargetIr {
  return { id: profile.id, semanticsNode: profile.semanticsNode, readableBareRead: profile.features.readableBareRead };
}

const NODE_CONDITIONS = ["node", "import", "default"] as const;

export const RUNTIME_TARGETS: Readonly<Record<RuntimeTargetId, RuntimeTargetProfile>> = {
  node24: {
    id: NODE24_TARGET_ID,
    family: "node",
    semanticsNode: NODE24_VERSION,
    pins: { node: NODE24_VERSION },
    typeSurface: "node",
    conditions: NODE_CONDITIONS,
    bunGlobal: false,
    features: { readableBareRead: "collapse-queue" },
  },
  node26: {
    id: NODE26_TARGET_ID,
    family: "node",
    semanticsNode: NODE26_VERSION,
    pins: { node: NODE26_VERSION },
    typeSurface: "node",
    conditions: NODE_CONDITIONS,
    bunGlobal: false,
    features: { readableBareRead: "head-chunk" },
  },
  bun: {
    id: "bun",
    family: "bun",
    semanticsNode: NODE24_VERSION,
    pins: { node: NODE24_VERSION, bun: BUN_VERSION },
    typeSurface: "bun",
    // Bun's own match order (`Bun.build({ conditions: ["bun", "node"] })`
    // is how the redcode workspace ships).
    conditions: ["bun", "node", "import", "default"],
    bunGlobal: true,
    // Bun's streams are Node 24's here until the bun census says otherwise.
    features: { readableBareRead: "collapse-queue" },
  },
};

export function isRuntimeTargetId(value: string): value is RuntimeTargetId {
  return (RUNTIME_TARGET_IDS as readonly string[]).includes(value);
}

/** How the target was chosen — the CLI prints a one-line note when a
 * project file (not a flag) decided. */
export type RuntimeTargetOrigin =
  | { kind: "flag" }
  | { kind: "env"; variable: string }
  | { kind: "project"; file: string; field: string }
  | { kind: "default" };

export interface ResolvedRuntimeTarget {
  readonly profile: RuntimeTargetProfile;
  readonly origin: RuntimeTargetOrigin;
}

/** Nearest package.json at or above `dir` (the entry's package scope). */
function nearestPackageJson(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The first of `names` found walking UP from `dir`, or null. */
function findUpward(dir: string, names: readonly string[]): string | null {
  let current = resolve(dir);
  for (;;) {
    for (const name of names) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function nodeTargetForMajor(major: number): RuntimeTargetId | null {
  if (major >= 26) return "node26";
  if (major >= 24) return "node24";
  return null;
}

function majorOfVersionText(text: string): number | null {
  const m = /(\d+)/.exec(text.trim().replace(/^v/, ""));
  return m ? Number(m[1]) : null;
}

/** Selects the runtime target: an explicit id, then `SCRIPTC_RUNTIME_TARGET`,
 * then the project's own declarations walking up from the entry — a
 * `packageManager: "bun@…"` pin, a `bunfig.toml`/`.bun-version`, then
 * `.node-version`/`.nvmrc`/`engines.node` — and `node24` when nothing
 * speaks. A project-file inference is reported so the CLI can say so. */
export function resolveRuntimeTarget(
  entryPath: string,
  explicit: RuntimeTargetId | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeTarget {
  if (explicit !== undefined) return { profile: RUNTIME_TARGETS[explicit], origin: { kind: "flag" } };
  const fromEnv = env["SCRIPTC_RUNTIME_TARGET"];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isRuntimeTargetId(fromEnv)) {
      throw new Error(`SCRIPTC_RUNTIME_TARGET names an unknown target "${fromEnv}" (supported: ${RUNTIME_TARGET_IDS.join(", ")})`);
    }
    return { profile: RUNTIME_TARGETS[fromEnv], origin: { kind: "env", variable: "SCRIPTC_RUNTIME_TARGET" } };
  }
  const dir = dirname(resolve(entryPath));
  // Walk every package.json scope upward: a workspace member without its
  // own pin inherits the workspace root's packageManager.
  let scope = nearestPackageJson(dir);
  let engines: { file: string; major: number } | null = null;
  while (scope !== null) {
    const pkg = readJson(scope);
    const packageManager = pkg?.["packageManager"];
    if (typeof packageManager === "string" && /^bun(@|$)/.test(packageManager)) {
      return { profile: RUNTIME_TARGETS.bun, origin: { kind: "project", file: scope, field: "packageManager" } };
    }
    const enginesNode = (pkg?.["engines"] as Record<string, unknown> | undefined)?.["node"];
    if (engines === null && typeof enginesNode === "string") {
      const major = majorOfVersionText(enginesNode);
      if (major !== null) engines = { file: scope, major };
    }
    const parent = dirname(dirname(scope));
    scope = parent === dirname(scope) ? null : nearestPackageJson(parent);
  }
  const bunMarker = findUpward(dir, ["bunfig.toml", ".bun-version"]);
  if (bunMarker !== null) {
    return { profile: RUNTIME_TARGETS.bun, origin: { kind: "project", file: bunMarker, field: "file" } };
  }
  const nodeVersionFile = findUpward(dir, [".node-version", ".nvmrc"]);
  if (nodeVersionFile !== null) {
    const major = majorOfVersionText(readFileSync(nodeVersionFile, "utf8"));
    const id = major === null ? null : nodeTargetForMajor(major);
    if (id !== null) return { profile: RUNTIME_TARGETS[id], origin: { kind: "project", file: nodeVersionFile, field: "version" } };
  }
  if (engines !== null) {
    const id = nodeTargetForMajor(engines.major);
    if (id !== null) return { profile: RUNTIME_TARGETS[id], origin: { kind: "project", file: engines.file, field: "engines.node" } };
  }
  return { profile: RUNTIME_TARGETS.node24, origin: { kind: "default" } };
}

/** One line for the CLI's stderr when a project file decided. */
export function describeRuntimeTargetOrigin(resolved: ResolvedRuntimeTarget, cwd: string = process.cwd()): string | null {
  const { origin, profile } = resolved;
  if (origin.kind !== "project") return null;
  const file = origin.file.startsWith(cwd + "/") ? origin.file.slice(cwd.length + 1) : origin.file;
  const via = origin.field === "file" || origin.field === "version" ? file : `${origin.field} in ${file}`;
  return `target: ${profile.id} (inferred from ${via}; pass --target to choose)`;
}

/* ── the active target ────────────────────────────────────────────────
 * Module-level state, like the resolver's path aliases and the npm-static
 * set: one compile selects one target before the frontend loads, and the
 * resolver, the program loader, and the lowerings read it. The default
 * (no selection) is node24 with no extra conditions — the historical
 * behavior. */

let active: RuntimeTargetProfile = RUNTIME_TARGETS.node24;
let extraConditions: readonly string[] = [];

export function setActiveRuntimeTarget(profile: RuntimeTargetProfile, conditions: readonly string[] = []): void {
  active = profile;
  extraConditions = conditions.filter((c) => c !== "");
}

export function activeRuntimeTarget(): RuntimeTargetProfile {
  return active;
}

/** The runtime conditions in match order: the profile's, then the user's
 * `--conditions` (deduplicated, profile order first). */
export function activeRuntimeConditions(): readonly string[] {
  const out: string[] = [];
  for (const c of [...active.conditions, ...extraConditions]) if (!out.includes(c)) out.push(c);
  return out;
}

/** The cache-key spelling of one selection (the CLI's lightweight cache
 * route computes it without loading the compiler graph). */
export function runtimeTargetKey(profile: RuntimeTargetProfile, conditions: readonly string[] = []): string {
  const all: string[] = [];
  for (const c of [...profile.conditions, ...conditions]) if (c !== "" && !all.includes(c)) all.push(c);
  return `${profile.id}:${JSON.stringify(profile.pins)}:${all.join(",")}`;
}

/** The cache-key spelling of the active selection. */
export function activeRuntimeTargetKey(): string {
  return runtimeTargetKey(active, extraConditions);
}
