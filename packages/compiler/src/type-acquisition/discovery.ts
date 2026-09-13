import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "semver";
import * as ts from "../frontend/ts7/adapter.js";
import { loadProgram } from "../frontend/program.js";
import { resolveBareModule } from "../frontend/resolve.js";
import { trackedFileExists, trackedReadFile } from "../frontend/input-tracker.js";
import { packageNameOfSpecifier } from "../frontend/workspace-registry.js";
import { digest, object, packageName, string } from "./store.js";

export interface TypeRequest {
  from: string;
  specifier: string;
  mount: string;
  typesName: string;
  range: string;
  key: string;
}
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
export const typesNameOf = (name: string): string => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

export function lockDirectory(entry: string): string {
  for (let dir = dirname(resolve(entry)); ; dir = dirname(dir)) {
    if (trackedFileExists(join(dir, "package.json")) || trackedFileExists(join(dir, "tsconfig.json"))) return dir;
    if (dirname(dir) === dir) return dirname(resolve(entry));
  }
}

/** Only reached runtime imports with missing declarations need a download.
 * Existing ambient shims and checker-inferred JSDoc stay authoritative. */
export function discoverMissingTypes(entry: string, root: string, conditions: readonly string[],
  externalTypes?: Readonly<Record<string, string>>): TypeRequest[] {
  const load = loadProgram(entry, externalTypes === undefined ? {} : { externalTypes });
  try {
    const missing = load.program.getSemanticDiagnostics().filter(d => d.code === 7016);
    const requests: TypeRequest[] = [];
    for (const sf of load.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const sites = missing.filter(d => d.fileName === sf.fileName);
      if (sites.length === 0) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && sites.some(d => d.pos <= node.getStart() && d.end >= node.end)) {
          const specifier = node.text;
          const name = packageNameOfSpecifier(specifier);
          if (!builtins.has(specifier) && packageName(name) && !specifier.startsWith(".") && !specifier.startsWith("#")) {
            const runtime = resolveBareModule(sf.fileName, specifier, "js-only");
            const current = resolveBareModule(sf.fileName, specifier);
            if (runtime !== null && current !== null && /\.[cm]?js$/.test(current.typesFile)) {
              const request = requestFor(sf.fileName, specifier, root, conditions);
              if (request !== null) requests.push(request);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return requests;
  } finally { load.dispose(); }
}

function requestFor(from: string, specifier: string, root: string, conditions: readonly string[]): TypeRequest | null {
  const name = packageNameOfSpecifier(specifier);
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const installed = join(dir, "node_modules", name);
    const manifest = trackedReadFile(join(installed, "package.json"));
    if (manifest !== null) {
      const pkg = object(JSON.parse(manifest));
      const version = string(pkg["version"]);
      const parsed = parse(version);
      if (parsed === null) throw new Error(`cannot match declarations to runtime version ${name}@${version}`);
      const typesName = typesNameOf(name);
      const mount = join(dir, "node_modules", typesName);
      // An installed but incomplete @types surface must be corrected explicitly;
      // a download never shadows the consumer's installed declarations.
      if (trackedFileExists(join(mount, "package.json"))) return null;
      const identity = [relative(root, installed), name, version, digest(manifest), specifier, conditions];
      return { from, specifier, mount, typesName, range: parsed.major === 0 ? `~${parsed.major}.${parsed.minor}.0` : `${parsed.major}.x`, key: JSON.stringify(identity) };
    }
    if (dirname(dir) === dir) return null;
  }
}
