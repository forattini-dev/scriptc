/* Text-only parser island: literal payload size is not executable-code
 * density. No parser node or enum crosses into the TS7 program world. */
import ts from "typescript5";

/** Eligibility heuristic, never proof of native compilability. Require
 * physical source lines, then measure non-comment code with pure literal
 * data collapsed. Calls, computed keys, spreads, methods, getters and
 * template substitutions retain their executable syntax. */
export function looksUnminified(source: string, fileName: string): boolean {
  if (!source.includes("\n")) return false;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const diagnostics = (sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length !== 0) return false;

  // Postorder without a recursive visitor: tables can be large or deeply
  // nested. Only constant leaves and containers made entirely of data qualify.
  const nodes: ts.Node[] = [];
  const pending: ts.Node[] = [sf];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined) break;
    nodes.push(node);
    ts.forEachChild(node, (child) => { pending.push(child); });
  }
  const data = new Set<ts.Node>();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node === undefined) continue;
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) ||
      ts.isRegularExpressionLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail ||
      node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.OmittedExpression ||
      (ts.isParenthesizedExpression(node) && data.has(node.expression)) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
        ts.isNumericLiteral(node.operand)) ||
      (ts.isArrayLiteralExpression(node) && node.elements.every((element) => data.has(element))) ||
      (ts.isObjectLiteralExpression(node) && node.properties.every((property) =>
        ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && data.has(property.initializer)))) {
      data.add(node);
    }
  }

  const spans: { start: number; end: number }[] = [];
  pending.push(sf);
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (data.has(node)) spans.push({ start: node.getStart(sf), end: node.end });
    else ts.forEachChild(node, (child) => { pending.push(child); });
  }
  spans.sort((a, b) => a.start - b.start);

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sf.languageVariant, source);
  const code: string[] = [];
  let spanIndex = 0;
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    const start = scanner.getTokenPos();
    const span = spans[spanIndex];
    if (span !== undefined && start === span.start) {
      code.push("0");
      scanner.setTextPos(span.end);
      spanIndex++;
    } else if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia ||
      token === ts.SyntaxKind.ShebangTrivia) {
      // Preserve a token boundary, not comment-padding lines in the divisor.
      code.push(scanner.getTokenText().includes("\n") ? "\n" : " ");
    } else code.push(scanner.getTokenText());
  }
  const lines = code.join("").split("\n").map((line) => line.trim()).filter((line) => line.length !== 0);
  return lines.length !== 0 && lines.reduce((total, line) => total + line.length, 0) / lines.length <= 200;
}
