import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import * as ts from "./ts7/adapter.js";
import { isNodeModulesPath, projectDtsRuntimeSibling } from "./resolve.js";
import { parseConfigJson } from "./config-json.js";
import { nodeTypeSurfacePackageOf } from "./dts-paths.js";
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

/** A copy of a Node type surface package that a reached project's tsconfig
 * resolved, and that the program does not carry because it already carries
 * another copy of the same package. */
export interface NodeTypeSurfaceStandDown {
  /** The tsconfig whose types closure resolved the copy. */
  readonly config: string;
  /** The surface package: @types/node, undici-types, bun-types, or @types/bun. */
  readonly package: string;
  /** The installed copy that stood down (its package directory) and its version. */
  readonly dropped: { readonly root: string; readonly version: string | null };
  /** The copy the program carries, when it was already known at that point. */
  readonly kept: { readonly root: string; readonly version: string | null } | null;
}

export class ProjectDeclarations {
  private readonly configs = new Set<string>();
  private readonly declarations = new Set<string>();
  private readonly structural = new Set<string>();
  /* ONE NODE TYPE SURFACE PER PROGRAM. Every reached workspace project
   * contributes the declaration closure of its own tsconfig `types`, and a
   * monorepo's projects routinely resolve different @types/node copies
   * (two majors, or two installs of one version). Loaded together they
   * declare the same ambient world twice: `node:events` ends up with two
   * `export =` assignments, `child_process` and `node:child_process` each
   * merge one full module with the other copy's re-export, and under the
   * forced skipLibCheck the collision surfaces only as user-site errors
   * ("Property 'on' does not exist on type 'ChildProcess'"). So each
   * surface package has one root here: the entry project's own resolution
   * (program.ts adopts it before any configuration is read), else the
   * first copy the checker or a configuration resolves. A later
   * configuration's different copy stands down and is recorded, so a
   * type error in that project can say which declarations it was really
   * checked against. */
  private readonly surface = new Map<string, string>();
  private readonly standDowns: NodeTypeSurfaceStandDown[] = [];
  private readonly canonical = new Map<string, string>();

  /** `adoptedSurface`: the entry project's own Node type surface files
   * (program.ts's resolution) — their packages win over every later copy. */
  constructor(private readonly host: ts.Ts7Host, adoptedSurface: readonly string[] = []) {
    for (const file of adoptedSurface) this.claimSurface(file);
  }

  collect(files: readonly string[]): readonly string[] {
    for (const file of files) {
      if (isNodeModulesPath(file) || /\.d\.(?:ts|mts|cts)$/.test(file)) continue;
      const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
      if (config !== undefined) this.collectConfig(config);
    }
    return [...this.declarations].sort();
  }

  createProgram(roots: string[], options: ts.Ts7CompilerOptions): ts.Program {
    let program = ts.createProgram(roots, options, this.host);
    for (;;) {
      // The checker's own resolution is ground truth for the surface the
      // program carries (the adopted root's undici-types, a bun surface's
      // @types/node reference): configurations read after it defer to it.
      for (const file of program.getSourceFileNames()) this.claimSurface(file);
      const added = this.collect(program.getSourceFiles()
        .filter((sf) => !sf.isDeclarationFile).map((sf) => sf.fileName))
        .filter((file) => !roots.includes(file));
      if (added.length === 0) break;
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

  /** The surface copies that stood down for the project configuration
   * governing `file` (its nearest tsconfig), in resolution order. */
  standDownsFor(file: string): readonly NodeTypeSurfaceStandDown[] {
    if (this.standDowns.length === 0 || isNodeModulesPath(file)) return [];
    const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
    return config === undefined ? [] : this.standDowns.filter((entry) => entry.config === config);
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

  /** Admits one configuration's declaration closure under the one-surface
   * rule: a surface package file joins only when its copy is the program's
   * copy (or the first one seen); a different copy stands down. */
  private admit(config: string, closure: readonly string[]): void {
    // A copy of @types/node that stands down takes the undici-types it
    // resolved with it: that dependency belongs to the copy, and the one
    // the program carries brings its own.
    const nodeStandsDown = closure.some((file) => {
      const owner = nodeTypeSurfacePackageOf(file);
      return owner?.name === "@types/node" && this.claimedRoot(owner) !== null && this.claimedRoot(owner) !== this.canonicalRoot(owner.root);
    });
    const recorded = new Set<string>();
    for (const file of closure) {
      const owner = nodeTypeSurfacePackageOf(file);
      if (owner !== null) {
        const root = this.canonicalRoot(owner.root);
        const kept = this.claimedRoot(owner);
        const standsDown = (kept !== null && kept !== root) || (nodeStandsDown && owner.name === "undici-types" && kept === null);
        if (standsDown) {
          if (!recorded.has(root)) {
            recorded.add(root);
            this.standDowns.push({
              config, package: owner.name,
              dropped: { root, version: packageVersion(root) },
              kept: kept === null ? null : { root: kept, version: packageVersion(kept) },
            });
          }
          continue;
        }
        this.surface.set(owner.name, root);
      }
      this.declarations.add(file);
      this.preserveStructuralDeclaration(file);
    }
  }

  private claimedRoot(owner: { name: string }): string | null {
    return this.surface.get(owner.name) ?? null;
  }

  private claimSurface(file: string): void {
    const owner = nodeTypeSurfacePackageOf(file);
    if (owner !== null && !this.surface.has(owner.name)) this.surface.set(owner.name, this.canonicalRoot(owner.root));
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
