/* Preserve erased public types without restoring declared VALUE signatures.
 * This syntactic bridge appends JSDoc aliases to ESM runtime sources; the
 * checker and lowerer still share the original inferred executable surface.
 * Copies of self-contained declarations exist only in the host overlay.
 * Declaration imports/external reexports, generic exports, export-star runtime barrels
 * and ambiguous names are deliberately left to the normal fallback path. */
import { declarationText, npmDeclarationCandidates } from "./npm-static-declarations.js";
import { dirname, resolve } from "node:path";
import ts from "typescript5";
import { trackedFileExists, trackedReadFile } from "./input-tracker.js";
import { resolveExports } from "./resolve.js";

const runtimeConditions = new Set(["node", "import", "default"]);
const declarationName = /\.d\.(?:ts|mts|cts)$/;
const virtualDeclarations = new Set<string>();
const normalizePath = (path: string): string => path.replaceAll("\\", "/");

/** Provenance, never a filename suffix: only this load's compiler-owned
 * copies describe structural types alongside statically compiled JS. */
export function isNpmStaticTypeFile(path: string): boolean { return virtualDeclarations.has(normalizePath(path)); }
export function resetNpmStaticTypes(): void { virtualDeclarations.clear(); }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Only exact entry mappings with an explicit types target are bridged.
 * Patterns and nested conditional declaration graphs need their own resolver
 * coverage before admission. Sibling declarations cover internal ESM files. */
function declarationFor(path: string, packageName: string): string | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const text = trackedReadFile(`${dir}/package.json`);
    let pkg: Record<string, unknown> | null = null;
    try { pkg = text === null ? null : record(JSON.parse(text)); } catch { /* resolver diagnoses malformed JSON */ }
    if (pkg?.["name"] === packageName) {
      const exports = record(pkg["exports"]);
      const entries = exports !== null && Object.keys(exports).some((key) => key.startsWith("."))
        ? Object.entries(exports) : [[".", pkg["exports"]] as const];
      const matches = new Set<string>();
      for (const [subpath, entry] of entries) {
        if (subpath.includes("*")) continue;
        const types = record(entry)?.["types"];
        const runtime = resolveExports(entry, ".", runtimeConditions);
        if (typeof types === "string" && runtime !== null && normalizePath(resolve(dir, runtime)) === path) {
          matches.add(normalizePath(resolve(dir, types)));
        }
      }
      if (matches.size > 0) return matches.size === 1 ? [...matches][0] ?? null : null;
      const types = pkg["types"] ?? pkg["typings"];
      const main = pkg["main"] ?? "index.js";
      if (pkg["exports"] === undefined && typeof types === "string" &&
          typeof main === "string" && normalizePath(resolve(dir, main)) === path) return normalizePath(resolve(dir, types));
      break;
    }
    const parent = dirname(dir);
    if (parent === dir || dir.endsWith("/node_modules")) break;
  }
  const sibling = path.replace(/\.(mjs|js)$/, (_, ext: string) => ext === "mjs" ? ".d.mts" : ".d.ts");
  return sibling !== path && trackedFileExists(sibling) ? sibling : null;
}

function typeOnlyNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.referencedFiles.length > 0 || source.typeReferenceDirectives.length > 0 ||
      source.libReferenceDirectives.length > 0 || source.hasNoDefaultLib) return [];
  let selfContained = true;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
        ts.isImportTypeNode(node) || (ts.isExportDeclaration(node) &&
          (node.moduleSpecifier !== undefined || node.exportClause === undefined || !ts.isNamedExports(node.exportClause))) ||
        ts.isModuleDeclaration(node) || ts.isExportAssignment(node)) selfContained = false;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!selfContained) return [];
  const localTypes = new Set<string>();
  const valueNames = new Set<string>();
  const exports: { local: string; public: string }[] = [];
  for (const statement of source.statements) {
    if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        !statement.typeParameters?.length) {
      localTypes.add(statement.name.text);
      if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
          !statement.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        exports.push({ local: statement.name.text, public: statement.name.text });
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const member of statement.exportClause.elements) {
        exports.push({ local: (member.propertyName ?? member.name).text, public: member.name.text });
      }
    } else if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      valueNames.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) valueNames.add(declaration.name.text);
      }
    }
  }
  return exports.filter((entry) => localTypes.has(entry.local) && !valueNames.has(entry.local) &&
    entry.public !== "default" && /^[A-Za-z_$][\w$]*$/.test(entry.public)).map((entry) => entry.public);
}

export class NpmStaticTypeBridge {
  private readonly files = new Map<string, string>();
  private readonly candidates = npmDeclarationCandidates();

  readFile(path: string): string | undefined { return this.files.get(normalizePath(path)); }
  fileExists(path: string): boolean { return this.files.has(normalizePath(path)); }

  append(path: string, text: string, packageName: string): string {
    path = normalizePath(path);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (!ts.isExternalModule(source) || source.statements.some((s) =>
      ts.isExportDeclaration(s) && s.exportClause === undefined)) return text;
    const candidate = this.candidates?.get(path);
    const declaration = candidate === undefined ? declarationFor(path, packageName) : candidate;
    if (declaration === null || !declarationName.test(declaration)) return text;
    const declaredText = declarationText(declaration);
    if (declaredText === null) return text;
    // Refuse any name already mentioned in source, including JSDoc. This
    // intentionally conservative check avoids shadowing local bindings,
    // runtime reexports or an implementation's existing type annotations.
    const identifiers = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const names = [...new Set(typeOnlyNames(declaration, declaredText))].filter((name) => !identifiers.has(name));
    if (names.length === 0) return text;
    const virtualPath = candidate === undefined ? declaration.replace(declarationName, ".__scriptc-types.d.ts") : `${path}.__scriptc-types.d.ts`;
    if (trackedFileExists(virtualPath) || declarationText(virtualPath) !== null) return text;
    this.files.set(virtualPath, declaredText);
    virtualDeclarations.add(virtualPath);
    const specifier = JSON.stringify(virtualPath).replaceAll("*", "\\u002a");
    const aliases = names.map((name) =>
      `/** @typedef {import(${specifier}).${name}} ${name} */`).join("\n");
    return `${text}\n${aliases}\n`;
  }
}
