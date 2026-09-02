import ts from "typescript5";

/** Erase TypeScript syntax from a workspace runtime module before embedding it.
 * The module key and import specifiers stay unchanged, so the island graph
 * keeps Node's resolution and cache identity while its JS engine sees JS. */
export function npmExecutableSource(fileName: string, source: string): string {
  if (!fileName.endsWith(".ts")) return source;
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.Preserve,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
}
