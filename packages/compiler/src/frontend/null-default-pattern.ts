import * as ts from "./ts7/adapter.js";
import { isJsSourceFileName } from "./tsc-codes.js";

/** A null default alone does not prove that a JavaScript option accepts
 * only null. Identify unannotated slots whose existing checked-dynamic
 * reads must retain their runtime values; do not change a static ABI. */
export function nullDefaultPattern(parameter: ts.ParameterDeclaration): ts.ObjectBindingPattern | null {
  if (parameter.type !== undefined || parameter.dotDotDotToken !== undefined ||
      !isJsSourceFileName(parameter.getSourceFile().fileName) ||
      !ts.isObjectBindingPattern(parameter.name)) return null;
  const owner = parameter.parent;
  const source = parameter.getSourceFile().text;
  const comments = source.slice(owner.pos, owner.getStart()) + source.slice(parameter.pos, parameter.name.getStart());
  if (/@(?:param|type|template|overload)\b/.test(comments)) return null;
  return parameter.name.elements.some(nullDefaultElement) ? parameter.name : null;
}

export function nullDefaultElement(element: ts.BindingElement): boolean {
  return element.initializer?.kind === ts.SyntaxKind.NullKeyword &&
    element.dotDotDotToken === undefined && element.name !== undefined &&
    ts.isIdentifier(element.name) &&
    (element.propertyName === undefined || ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName));
}

export function nullDefaultBinding(name: ts.BindingName): boolean {
  const element = name.parent;
  if (!ts.isBindingElement(element) || !nullDefaultElement(element)) return false;
  const pattern = element.parent;
  return ts.isObjectBindingPattern(pattern) && ts.isParameter(pattern.parent) &&
    nullDefaultPattern(pattern.parent) === pattern;
}
