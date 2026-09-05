import ts from "typescript5";

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

export function npmExecutableSource(fileName: string, source: string): string {
  const typescript = /\.(ts|tsx|mts|cts)$/.test(fileName) && !fileName.endsWith(".d.ts");
  if (!typescript) {
    if (!/\.(js|mjs|cjs|jsx)$/.test(fileName) || !USES_EXPLICIT_RESOURCES.test(source)) return source;
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
      verbatimModuleSyntax: true,
      ...jsx,
    },
  }).outputText;
}
