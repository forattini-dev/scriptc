import * as ts from "./ast.js";
import { SyntaxKind } from "./enums.js";

/** Only a class's extends clause evaluates an expression. Newer TS7 ASTs
 * represent interface extends and class implements with TypeReference nodes. */
export function classExtendsElement(decl: ts.ClassLikeDeclaration): ts.ExpressionWithTypeArguments | undefined {
  const element = decl.heritageClauses?.find((clause) => clause.token === SyntaxKind.ExtendsKeyword)?.types[0];
  return element !== undefined && ts.isExpressionWithTypeArguments(element) ? element : undefined;
}

/** The terminal name of type-only heritage, in either TS7 AST representation.
 * Keep qualified type names in the type world; they are not property reads. */
export function heritageTypeName(element: ts.Node): ts.Identifier | undefined {
  if (ts.isTypeReferenceNode(element)) {
    const name = ts.isIdentifier(element.typeName) ? element.typeName : element.typeName.right;
    return ts.isIdentifier(name) ? name : undefined;
  }
  if (ts.isExpressionWithTypeArguments(element)) {
    const expression = element.expression;
    if (ts.isIdentifier(expression)) return expression;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name;
  }
  return undefined;
}
