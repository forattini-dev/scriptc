import * as ts from "../ts7/adapter.js";

/** An indexed read contributing directly to an inferred lambda return. Calls
 * and property consumers retain their own argument and receiver contracts. */
export function inferredLambdaRead(node: ts.Node): ts.ArrowFunction | ts.FunctionExpression | null {
  let value = node;
  for (;;) {
    const parent = value.parent;
    if (!parent) return null;
    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && parent.body === value) {
      return parent.type ? null : parent;
    }
    if (ts.isReturnStatement(parent) && parent.expression === value) {
      for (let owner: ts.Node = parent.parent; owner; owner = owner.parent) {
        if (ts.isFunctionLike(owner)) {
          return (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) && !owner.type ? owner : null;
        }
        if (ts.isSourceFile(owner)) return null;
      }
      return null;
    }
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertion(parent)) {
      value = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
      value = parent;
      continue;
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== value) {
      value = parent;
      continue;
    }
    return null;
  }
}
