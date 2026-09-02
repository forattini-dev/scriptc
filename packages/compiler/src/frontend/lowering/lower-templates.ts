import * as ts from "../ts7/adapter.js";

/** A template piece's RAW text (String.raw's contract: escapes stay
 * characters). TypeScript 7's client AST omits rawText at runtime, so read
 * the raw span from source; TypeScript 5.9's rawText wins when present. */
export function templateRawTextOf(
  node: ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail,
): string {
  const own = (node as { rawText?: string }).rawText;
  if (own !== undefined) return own;
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const tailTrim = node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ? 2 : 1;
  return sourceFile.text.slice(start + 1, end - tailTrim);
}
