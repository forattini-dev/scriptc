/* Bun's CommonJS named-export surface, for the --target bun island.
 *
 * Node builds a CJS module's ESM facade by LEXING (cjs-lexer.ts mirrors
 * its vendored lexer, quirks included); Bun EVALUATES the module and
 * exposes every own key of its `module.exports` as a named export. A
 * compiled binary cannot evaluate at build time, so under the bun target
 * the facade's export list is the lexer's names plus a PERMISSIVE
 * syntactic superset of what evaluation would expose: every key of every
 * `module.exports = { … }` literal (any value shape, any nesting),
 * `exports.x = …` / `module.exports.x = …` assignments, and
 * `Object.defineProperty(exports, "x", …)` calls; `module.exports =
 * require(…)` and `...require(…)` spreads re-export their target's names.
 * A listed name the module never defines is simply undefined through the
 * facade — exactly Bun's answer for a missing key — while an unlisted
 * name would refuse the whole graph at link time. */
import ts from "typescript5";

export interface CjsBunExports {
  exports: Set<string>;
  reexports: string[];
}

function isExportsIdent(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "exports";
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    ts.isIdentifier(node.name) &&
    node.name.text === "exports"
  );
}

function requireSpecOf(node: ts.Expression): string | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require" &&
    expr.arguments.length === 1 &&
    ts.isStringLiteralLike(expr.arguments[0]!)
  ) {
    return expr.arguments[0]!.text;
  }
  return null;
}

function keyOf(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function scanLiteral(obj: ts.ObjectLiteralExpression, out: CjsBunExports): void {
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const spec = requireSpecOf(prop.expression);
      if (spec !== null) out.reexports.push(spec);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      out.exports.add(prop.name.text);
      continue;
    }
    const key = keyOf(prop.name);
    if (key !== null) out.exports.add(key);
  }
}

export function cjsBunVisibleExportsOf(source: string, fileName = "module.cjs"): CjsBunExports {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const out: CjsBunExports = { exports: new Set(), reexports: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = node.left;
      if (isModuleExports(lhs)) {
        let rhs = node.right;
        while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
        const spec = requireSpecOf(rhs);
        if (spec !== null) out.reexports.push(spec);
        else if (ts.isObjectLiteralExpression(rhs)) scanLiteral(rhs, out);
      } else if (
        ts.isPropertyAccessExpression(lhs) &&
        lhs.questionDotToken === undefined &&
        (isExportsIdent(lhs.expression) || isModuleExports(lhs.expression))
      ) {
        out.exports.add(lhs.name.text);
      } else if (
        ts.isElementAccessExpression(lhs) &&
        (isExportsIdent(lhs.expression) || isModuleExports(lhs.expression)) &&
        ts.isStringLiteralLike(lhs.argumentExpression)
      ) {
        out.exports.add(lhs.argumentExpression.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty" &&
      node.arguments.length >= 2 &&
      (isExportsIdent(node.arguments[0]!) || isModuleExports(node.arguments[0]!)) &&
      ts.isStringLiteralLike(node.arguments[1]!)
    ) {
      out.exports.add(node.arguments[1]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  out.exports.delete("default");
  out.exports.delete("__esModule");
  return out;
}
