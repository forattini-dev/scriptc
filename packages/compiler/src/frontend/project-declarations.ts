import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import * as ts from "./ts7/adapter.js";
import { isNodeModulesPath, projectDtsRuntimeSibling } from "./resolve.js";
import { parseConfigJson } from "./config-json.js";

/** Only configured declaration roots join the checker. A tsconfig's other
 * files are not additional executable entrypoints. Each reached workspace
 * source uses its own nearest configuration, not a recursive repo scan. */
const structuralDeclarations = new WeakSet<ts.SourceFile>();

/** Program-owned identities: no filename-global state can leak into another load. */
export function isProjectTypeFile(sf: ts.SourceFile): boolean {
  return structuralDeclarations.has(sf);
}

export class ProjectDeclarations {
  private readonly configs = new Set<string>();
  private readonly declarations = new Set<string>();
  private readonly structural = new Set<string>();

  constructor(private readonly host: ts.Ts7Host) {}

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

  private collectConfig(config: string): void {
    if (this.configs.has(config)) return;
    this.configs.add(config);
    const parsed = this.host.parseConfigFile(config);
    for (const candidate of parsed.fileNames) {
      const declaration = resolve(dirname(config), candidate);
      // A runtime twin must continue through body inference, even when
      // its declaration happens to be included by a broad project glob.
      if (/\.d\.(?:ts|mts|cts)$/.test(declaration) && projectDtsRuntimeSibling(declaration) === null) {
        this.declarations.add(declaration);
        if (!isNodeModulesPath(declaration)) this.structural.add(declaration);
      }
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
          if (sf.isDeclarationFile && projectDtsRuntimeSibling(sf.fileName) === null) {
            this.declarations.add(sf.fileName);
            if (!isNodeModulesPath(sf.fileName)) this.structural.add(sf.fileName);
          }
        }
      } finally { program.dispose(); }
    }
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
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string")
    ? value as string[] : undefined;
}
