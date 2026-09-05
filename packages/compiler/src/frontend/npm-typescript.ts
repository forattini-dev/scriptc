import ts from "typescript5";
import { activeRuntimeTarget } from "../compat/runtime-target.js";

/** The project's JSX posture for EMBEDDED .tsx modules (adopted from its
 * tsconfig by program.ts): the engine needs plain JavaScript, so
 * `preserve` and the dev/native flavors all emit through the automatic
 * runtime against the project's jsxImportSource. Null = no JSX config
 * (a .tsx module then emits through the automatic React runtime). */
let embedJsx: { jsxImportSource?: string } | null = null;

export function setEmbedJsxOptions(options: { jsxImportSource?: string } | null): void {
  embedJsx = options;
}

/** Erase TypeScript syntax from a workspace runtime module before embedding it.
 * The module key and import specifiers stay unchanged, so the island graph
 * keeps Node's resolution and cache identity while its JS engine sees JS. */
/** `using` / `await using` in the source — syntax the boa island compiles
 * but does not run (block disposal is skipped, and a `using` inside a
 * function aborts the engine), so embedded sources that carry it, TS or
 * JS, downlevel to the ES2022 try/finally form the helpers implement. */
const USES_EXPLICIT_RESOURCES = /\b(?:await\s+)?using\s+[A-Za-z_$]/;
/** An export LIST (`export { a, b }`, no `from`): boa 0.22 refuses one
 * that ends the file without a semicolon ("abrupt end" — ASI at EOF is
 * not applied after the clause), a common shape in semicolon-free
 * packages (fetch-blob). The TypeScript emitter normalizes semicolons,
 * so such sources take the transpile path too. */
const HAS_EXPORT_LIST = /\bexport\s*\{[^}]*\}(?!\s*from\b)/;

export function npmExecutableSource(fileName: string, source: string): string {
  const typescript = /\.(ts|tsx|mts|cts)$/.test(fileName) && !fileName.endsWith(".d.ts");
  if (!typescript) {
    if (!/\.(js|mjs|cjs|jsx)$/.test(fileName)) return source;
    if (!USES_EXPLICIT_RESOURCES.test(source) && !HAS_EXPORT_LIST.test(source)) return source;
    return ts.transpileModule(source, {
      fileName,
      compilerOptions: { module: ts.ModuleKind.Preserve, target: ts.ScriptTarget.ES2022, allowJs: true },
    }).outputText;
  }
  const jsx = fileName.endsWith(".tsx")
    ? {
        jsx: ts.JsxEmit.ReactJSX,
        ...(embedJsx?.jsxImportSource !== undefined ? { jsxImportSource: embedJsx.jsxImportSource } : {}),
      }
    : {};
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.Preserve,
      // ES2022: `using` downlevels to try/finally (see above); every other
      // syntax the island's engines run is ES2022 or older already.
      target: ts.ScriptTarget.ES2022,
      // Bun's transpiler drops an import whose specifiers are all
      // `type` (`import { type rpc } from "../tui/worker"`) even under
      // verbatimModuleSyntax — the worker script behind it must not run
      // in the main thread — while Node's type stripping keeps the
      // side-effect import, as verbatimModuleSyntax specifies.
      verbatimModuleSyntax: activeRuntimeTarget().family !== "bun",
      ...jsx,
    },
  }).outputText;
}

/** True when a JavaScript source carries ES module syntax at its top
 * level (import/export declarations, `export default`). A ".js" file in
 * a CommonJS-typed package that spells these is not CommonJS whatever
 * the package.json says — Node would refuse it outright, while the
 * bundler-style "module" field resolution the embedder follows leads
 * straight into such files (jsonc-parser's lib/esm/*.js). */
export function hasEsmSyntax(fileName: string, source: string): boolean {
  if (!/^\s*(?:import|export)\b/m.test(source)) return false;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return sf.statements.some((statement) =>
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement) ||
    (ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)));
}
