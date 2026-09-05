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
export function npmExecutableSource(fileName: string, source: string): string {
  if (!/\.(ts|tsx|mts|cts)$/.test(fileName) || fileName.endsWith(".d.ts")) return source;
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
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
      ...jsx,
    },
  }).outputText;
}
