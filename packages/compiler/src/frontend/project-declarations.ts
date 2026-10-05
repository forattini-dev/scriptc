import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { compare, parse } from "semver";
import * as ts from "./ts7/adapter.js";
import { isNodeModulesPath, projectDtsRuntimeSibling } from "./resolve.js";
import { parseConfigJson } from "./config-json.js";
import { isUndiciTypesPath, nodeTypeSurfacePackageOf } from "./dts-paths.js";
import { trackedReadFile, trackedRealpath } from "./input-tracker.js";
import { npmStaticPackageOfPath } from "./npm-static.js";

/** Only configured declaration roots join the checker. A tsconfig's other
 * files are not additional executable entrypoints. Each reached workspace
 * source uses its own nearest configuration, not a recursive repo scan. */
const structuralDeclarations = new WeakSet<ts.SourceFile>();

/** Program-owned identities: no filename-global state can leak into another load. */
export function isProjectTypeFile(sf: ts.SourceFile): boolean {
  return structuralDeclarations.has(sf);
}

/** An installed copy of an ambient Node type surface package that a
 * project's own resolution selects and the program does not carry, because
 * the program carries a newer copy of the same package. */
export interface NodeTypeSurfaceStandDown {
  /** The tsconfig whose resolution selected the copy. */
  readonly config: string;
  /** The surface package: @types/node, bun-types, or @types/bun. */
  readonly package: string;
  /** The installed copy that stood down (its package directory) and its version. */
  readonly dropped: { readonly root: string; readonly version: string | null };
  /** The copy the program carries. */
  readonly kept: { readonly root: string; readonly version: string | null };
}

/** One installed copy of an ambient surface package. */
interface SurfaceCopy {
  readonly name: string;
  /** Real path of the package directory: a symlinked install and its store entry are one copy. */
  readonly root: string;
  readonly version: string | null;
  /** Discovery order: the tiebreak between copies of one version. */
  readonly order: number;
  /** Every declaration file of the copy the program has reached or a closure listed. */
  readonly files: Set<string>;
}

/** Orders two package versions: newer first wins. A missing or unparseable
 * version is older than any parseable one. */
export function compareSurfaceVersions(a: string | null, b: string | null): number {
  const left = a === null ? null : parse(a);
  const right = b === null ? null : parse(b);
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  return compare(left, right);
}

export class ProjectDeclarations {
  private readonly configs = new Set<string>();
  private readonly declarations = new Set<string>();
  private readonly structural = new Set<string>();
  /* ONE COPY OF EACH AMBIENT NODE TYPE PACKAGE PER PROGRAM. Every reached
   * workspace project contributes the declaration closure of its own
   * tsconfig `types`, and a monorepo's projects routinely resolve different
   * @types/node copies (two majors, or two installs of one version).
   * Loaded together they declare one ambient world twice: the old
   * @types/node layout (22, 24) declares `events` and the modules that
   * re-export `node:events` the opposite way round from the new layout
   * (25 and later), so when an old copy is merged before a new one,
   * `node:events` carries two `export =` assignments and ChildProcess and
   * net.Server lose their EventEmitter members. Under the forced
   * skipLibCheck that collision surfaces only as user-site errors
   * ("Property 'on' does not exist on type 'ChildProcess'") in whichever
   * project loses the merge. Two copies of one layout collide too (their
   * classes are duplicate declarations; only function and interface
   * overloads happen to merge), just less visibly.
   *
   * So each ambient package has ONE copy here, chosen by a rule that does
   * not depend on discovery order: the NEWEST version any reached project
   * (or the entry project's own ancestor resolution) selects, the first
   * discovered copy winning a tie. Newest, not the entry's, because the
   * surface only has to be a superset of what each project calls: a type
   * surface grows far more often than it drops members between majors, so
   * a reached project written against the newer copy keeps compiling,
   * while preferring the entry's older copy would reject it. Every other
   * copy stands down: its files leave the program's roots AND are served
   * empty (Ts7Host.shadowFile), because tsgo resolves a
   * `/// <reference types="node" />` in any declaration file on its own,
   * and that resolution must not bring the older copy back. A stood-down
   * copy is recorded against the projects whose resolution selected it, so
   * a type error in such a project can say which declarations it was really
   * checked against.
   *
   * undici-types is module-shaped (see AMBIENT_SURFACE_PACKAGES): it follows
   * the @types/node copy that listed it, and a second copy it leaves in the
   * program through some other package's import declares nothing twice. */
  private readonly copies = new Map<string, SurfaceCopy[]>();
  private readonly copyByRoot = new Map<string, SurfaceCopy>();
  private readonly copyByFile = new Map<string, SurfaceCopy>();
  private readonly followsCopy = new Map<string, SurfaceCopy>();
  /** Surface files the checker reached on its own (a type directive in some
   * declaration file): if their copy wins, they become explicit roots, since
   * the file that pulled them in may belong to a copy that stood down. */
  private readonly reached = new Set<string>();
  private readonly projectCopies = new Map<string, Set<SurfaceCopy>>();
  private readonly shadowed = new Set<string>();
  private readonly ownerCache = new Map<string, { name: string; root: string } | null>();
  private readonly canonical = new Map<string, string>();

  /** `adoptedSurface`: the Node type surface files the entry project's own
   * ancestor resolution found (program.ts); they compete under the same
   * rule as every configuration's copies and count as the entry project's
   * selection. */
  constructor(private readonly host: ts.Ts7Host, adoptedSurface: readonly string[] = [], entryPath: string | null = null) {
    const config = entryPath === null ? undefined : ts.findConfigFile(dirname(entryPath), ts.sys.fileExists);
    for (const file of adoptedSurface) {
      const copy = this.register(file);
      if (copy !== null && config !== undefined) this.select(config, copy);
    }
  }

  collect(files: readonly string[]): readonly string[] {
    for (const file of files) {
      if (isNodeModulesPath(file) || /\.d\.(?:ts|mts|cts)$/.test(file)) continue;
      const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
      if (config !== undefined) this.collectConfig(config);
    }
    return [...new Set([...this.declarations, ...this.reached])].filter((file) => !this.standsDown(file)).sort();
  }

  createProgram(roots: string[], options: ts.Ts7CompilerOptions): ts.Program {
    this.syncShadows();
    this.pruneRoots(roots);
    let program = ts.createProgram(roots, options, this.host);
    for (;;) {
      // The checker's own resolution is ground truth for which copies the
      // program reached (a `/// <reference types>` directive in some
      // declaration file, a package's own import): each joins the election.
      for (const file of program.getSourceFileNames()) if (this.register(file) !== null) this.reached.add(file);
      const added = this.collect(program.getSourceFiles()
        .filter((sf) => !sf.isDeclarationFile).map((sf) => sf.fileName))
        .filter((file) => !roots.includes(file));
      const shadowed = this.syncShadows();
      this.pruneRoots(roots);
      if (added.length === 0 && !shadowed) break;
      roots.push(...added);
      program.dispose();
      program = ts.createProgram(roots, options, this.host);
    }
    for (const path of this.structural) {
      const sf = program.getSourceFile(path);
      if (sf !== undefined) structuralDeclarations.add(sf);
    }
    return program;
  }

  /** The ambient surface copies the project configuration governing `file`
   * (its nearest tsconfig) selected and the program does not carry, in
   * discovery order. */
  standDownsFor(file: string): readonly NodeTypeSurfaceStandDown[] {
    if (this.copyByRoot.size === 0 || isNodeModulesPath(file)) return [];
    const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
    const selected = config === undefined ? undefined : this.projectCopies.get(config);
    if (config === undefined || selected === undefined) return [];
    const result: NodeTypeSurfaceStandDown[] = [];
    for (const copy of [...selected].sort((x, y) => x.order - y.order)) {
      const kept = this.winner(copy);
      if (kept === copy) continue;
      result.push({
        config, package: copy.name,
        dropped: { root: copy.root, version: copy.version },
        kept: { root: kept.root, version: kept.version },
      });
    }
    return result;
  }

  private collectConfig(config: string): void {
    if (this.configs.has(config)) return;
    this.configs.add(config);
    const parsed = this.host.parseConfigFile(config);
    const closure: string[] = [];
    for (const candidate of parsed.fileNames) {
      const declaration = resolve(dirname(config), candidate);
      // A runtime twin must continue through body inference, even when
      // its declaration happens to be included by a broad project glob.
      if (/\.d\.(?:ts|mts|cts)$/.test(declaration) && !hasRuntimeTwin(declaration)) closure.push(declaration);
    }
    // Ask the same checker to resolve explicit types/typeRoots, including
    // inherited paths and package declaration dependencies. Do not enable
    // automatic ambient package inclusion for otherwise unconfigured apps.
    const types = stringList(parsed.options["types"]);
    const typeRoots = stringList(parsed.options["typeRoots"]);
    if (types !== undefined || typeRoots !== undefined) {
      const probe = resolve(dirname(config), `.scriptc-types-probe-${randomUUID()}.ts`);
      this.host.addVirtualFile(probe, "");
      const program = ts.createProgram([probe], {
        noLib: true, ...(types === undefined ? {} : { types }),
        ...(typeRoots === undefined ? {} : { typeRoots }),
      }, this.host);
      try {
        for (const sf of program.getSourceFiles()) {
          if (sf.isDeclarationFile && !hasRuntimeTwin(sf.fileName)) closure.push(sf.fileName);
        }
      } finally { program.dispose(); }
    }
    this.admit(config, closure);
    // Project references are not inherited through extends. Follow only
    // explicit references and keep their executable file lists excluded.
    let raw: unknown;
    try { raw = parseConfigJson(ts.sys.readFile(config) ?? ""); } catch { return; }
    if (raw === null || typeof raw !== "object" || !("references" in raw) || !Array.isArray(raw.references)) return;
    for (const ref of raw.references as unknown[]) {
      if (ref === null || typeof ref !== "object" || !("path" in ref) || typeof ref.path !== "string") continue;
      const target = resolve(dirname(config), ref.path);
      const referencedConfig = ts.sys.fileExists(target) ? target : resolve(target, "tsconfig.json");
      if (ts.sys.fileExists(referencedConfig)) this.collectConfig(referencedConfig);
    }
  }

  /** Admits one configuration's declaration closure: its ambient surface
   * copies join the election and are recorded as this project's selection;
   * whether their files stay roots is decided by the election, now and
   * whenever a newer copy turns up (see collect). */
  private admit(config: string, closure: readonly string[]): void {
    let nodeCopy: SurfaceCopy | null = null;
    for (const file of closure) {
      const copy = this.register(file);
      if (copy === null) continue;
      this.select(config, copy);
      if (copy.name === "@types/node") nodeCopy ??= copy;
    }
    for (const file of closure) {
      // The undici-types a @types/node copy resolved with belongs to that copy.
      if (nodeCopy !== null && isUndiciTypesPath(file)) this.followsCopy.set(file, nodeCopy);
      // A copy that already stands down stays down (a loser never wins
      // later: newer copies only get added), so its files never revive.
      if (this.standsDown(file)) continue;
      this.declarations.add(file);
      this.preserveStructuralDeclaration(file);
    }
  }

  /** The election among the copies of `copy`'s package: the newest version,
   * the earliest discovered on a tie (a total order, so the answer does not
   * depend on where the comparison starts). */
  private winner(copy: SurfaceCopy): SurfaceCopy {
    let best = copy;
    for (const other of this.copies.get(copy.name) ?? []) {
      const byVersion = compareSurfaceVersions(other.version, best.version);
      if (byVersion > 0 || (byVersion === 0 && other.order < best.order)) best = other;
    }
    return best;
  }

  /** The copy owning `file`, entered into the election on first sight. */
  private register(file: string): SurfaceCopy | null {
    const known = this.copyByFile.get(file);
    if (known !== undefined) return known;
    const owner = nodeTypeSurfacePackageOf(file, this.ownerCache);
    if (owner === null) return null;
    const root = this.canonicalRoot(owner.root);
    let copy = this.copyByRoot.get(root);
    if (copy === undefined) {
      copy = { name: owner.name, root, version: packageVersion(root), order: this.copyByRoot.size, files: new Set() };
      this.copyByRoot.set(root, copy);
      const list = this.copies.get(owner.name);
      if (list === undefined) this.copies.set(owner.name, [copy]); else list.push(copy);
    }
    copy.files.add(file);
    this.copyByFile.set(file, copy);
    return copy;
  }

  private select(config: string, copy: SurfaceCopy): void {
    const set = this.projectCopies.get(config);
    if (set === undefined) this.projectCopies.set(config, new Set([copy])); else set.add(copy);
  }

  /** True for a file of a copy the program does not carry (or that follows one). */
  private standsDown(file: string): boolean {
    const copy = this.copyByFile.get(file) ?? this.followsCopy.get(file);
    return copy !== undefined && this.winner(copy) !== copy;
  }

  /** Serves every known file of every stood-down copy empty. Returns true
   * when this call shadowed something new, so the program must be rebuilt. */
  private syncShadows(): boolean {
    let changed = false;
    for (const list of this.copies.values()) {
      const [first] = list;
      if (first === undefined || list.length < 2) continue;
      const kept = this.winner(first);
      for (const copy of list) {
        if (copy === kept) continue;
        for (const file of copy.files) {
          if (this.shadowed.has(file)) continue;
          this.shadowed.add(file);
          this.host.shadowFile(file);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Stood-down files leave the roots (the entry, at index 0, never does). */
  private pruneRoots(roots: string[]): void {
    for (let i = roots.length - 1; i > 0; i--) {
      const root = roots[i];
      if (root !== undefined && this.standsDown(root)) roots.splice(i, 1);
    }
  }

  /** Package directories compare by real path: a symlinked install and its
   * store entry are one copy. */
  private canonicalRoot(root: string): string {
    let canonical = this.canonical.get(root);
    if (canonical === undefined) {
      canonical = trackedRealpath(root) ?? root;
      this.canonical.set(root, canonical);
    }
    return canonical;
  }

  private preserveStructuralDeclaration(path: string): void {
    if (isNodeModulesPath(path)) return;
    this.structural.add(path);
    if (npmStaticPackageOfPath(path) === null) return;
    // Configured workspace declarations are authoring roots, even when
    // npm-static hides the package's shipped declaration surface. Serve the
    // exact tracked bytes above that shadow; never revive a runtime twin.
    const source = ts.sys.readFile(path);
    if (source !== undefined) this.host.addVirtualFile(path, source);
  }
}

function packageVersion(root: string): string | null {
  const text = trackedReadFile(resolve(root, "package.json"));
  if (text === null) return null;
  try {
    const version: unknown = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

function hasRuntimeTwin(path: string): boolean {
  if (projectDtsRuntimeSibling(path) !== null) return true;
  if (npmStaticPackageOfPath(path) === null) return false;
  const match = /\.d\.(ts|mts|cts)$/.exec(path);
  if (match === null) return false;
  const base = path.slice(0, -match[0].length);
  const extensions = match[1] === "mts" ? [".mts", ".mjs"]
    : match[1] === "cts" ? [".cts", ".cjs"] : [".ts", ".tsx", ".js", ".jsx"];
  return extensions.some(extension => ts.sys.fileExists(base + extension));
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string")
    ? value as string[] : undefined;
}
