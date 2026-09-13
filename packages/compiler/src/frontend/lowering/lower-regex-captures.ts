import { BOOL, STRING, UNDEFINED_T, typeEquals, type IrExpr, type IrType } from "../../ir/ir.js";
import { nodeThrowExpr } from "./lowerer.js";
import * as ts from "../ts7/adapter.js";
import { regexGroupsType } from "../regex-types.js";
import type { Lowerer } from "./lowerer.js";

/** The stdlib's string slot signature must not erase an absent capture
 * when a conditional joins it with another value. */
export function regexCaptureConditionalType(L: Lowerer, node: ts.ConditionalExpression, yes: IrType, no: IrType): IrType | null {
  if (!isRegexCaptureRead(L, node.whenTrue) && !isRegexCaptureRead(L, node.whenFalse)) return null;
  const arms = [yes, no].flatMap(type => type.kind === "union" ? L.unions.get(type.unionId)?.arms ?? [] : [type]);
  if (!arms.some(type => type.kind === "undefinedT")) return null;
  return { kind: "union", unionId: L.unions.intern(arms.filter((arm, index) => !arms.slice(0, index).some(other => typeEquals(arm, other)))) };
}

/** The lib's unconditionally-string capture signature is not a proof that
 * a group participated. Keep the native optional value at these reads. */
export function isRegexCaptureRead(L: Lowerer, node: ts.Node, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isParenthesizedExpression(node)) return isRegexCaptureRead(L, node.expression, seen);
  if (ts.isIdentifier(node)) {
    const symbol = L.resolveValueSymbol(node);
    const declaration = symbol ? L.checker.valueDeclarationOf(symbol) : undefined;
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && !declaration.type &&
      declaration.initializer !== undefined && isRegexCaptureRead(L, declaration.initializer, seen);
  }
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const receiver = L.checker.getNonNullableType(L.typeOf(node.expression));
  if (regexGroupsType(receiver, L.typeCtx)) return true;
  if (!ts.isElementAccessExpression(node)) return false;
  const symbol = receiver.getSymbol();
  return symbol !== undefined && (symbol.name === "RegExpMatchArray" || symbol.name === "RegExpExecArray") &&
    L.checker.declarationsOf(symbol).some((declaration) =>
      ts.isInterfaceDeclaration(declaration) && L.isStdlibFile(declaration.getSourceFile()));
}

/** An inferred direct capture return has the native optional ABI, including
 * callbacks passed to Array.map. Explicit return contracts stay checked. */
export function inferredRegexCaptureReturn(L: Lowerer, declaration: ts.SignatureDeclaration, type: IrType | null): IrType | null {
  if (declaration.type || type?.kind !== "string") return type;
  if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) {
    return isRegexCaptureRead(L, declaration.body) ? L.withUndefinedArm(type) : type;
  }
  if (!ts.isFunctionDeclaration(declaration) && !ts.isFunctionExpression(declaration) &&
      !ts.isMethodDeclaration(declaration) && !ts.isGetAccessorDeclaration(declaration) && !ts.isArrowFunction(declaration)) return type;
  let optional = false;
  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node) && node.expression && isRegexCaptureRead(L, node.expression)) optional = true;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    ts.forEachChild(node, visit);
  }
  if (declaration.body) visit(declaration.body);
  return optional ? L.withUndefinedArm(type) : type;
}

/** Check a capture used as a member receiver, evaluating the capture once. */
export function narrowRegexCaptureReceiver(L: Lowerer, value: IrExpr, node: ts.Node): IrExpr {
  const parent = node.parent;
  if (value.type.kind !== "union" || !ts.isPropertyAccessExpression(parent) || parent.expression !== node || parent.questionDotToken) return value;
  const stringTag = L.armTag(value.type.unionId, STRING);
  const undefinedTag = L.armTag(value.type.unionId, UNDEFINED_T);
  if (stringTag < 0 || undefinedTag < 0) return value;
  const key = `regexCaptureReceiver:${value.type.unionId}:${parent.name.text}`;
  let helper = L.widthHelpers.get(key);
  const loc = value.loc;
  if (!helper) {
    helper = `%regex.capture.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, helper);
    const parameter: IrExpr = { kind: "varRef", localId: "capture.0", type: value.type, loc };
    L.liftedFns.push({
      name: helper,
      params: [{ localId: "capture.0", name: "capture", type: value.type }],
      locals: [{ id: "capture.0", name: "capture", type: value.type, mutable: false }],
      returnType: STRING,
      body: [{ kind: "return", value: {
        kind: "ternary",
        cond: { kind: "unionIsTag", value: parameter, unionId: value.type.unionId, tag: undefinedTag, negated: false, type: BOOL, loc },
        then: nodeThrowExpr(1, "", `Cannot read properties of undefined (reading '${parent.name.text}')`, STRING, loc),
        else_: { kind: "unionNarrow", value: parameter, unionId: value.type.unionId, tag: stringTag, type: STRING, loc },
        type: STRING, loc,
      }, loc }], loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: STRING, loc };
}

/** Keep inferred storage consistent with native capture-producing values. */
export function inferredRegexBindingType(L: Lowerer, declaration: ts.VariableDeclaration, type: IrType): IrType {
  if (declaration.type || !declaration.initializer || !ts.isIdentifier(declaration.name)) return type;
  let value = declaration.initializer;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (type.kind === "string" && isRegexCaptureRead(L, value)) return L.withUndefinedArm(type) ?? type;
  if (ts.isIdentifier(value)) {
    const symbol = L.resolveValueSymbol(value);
    const actual = symbol ? L.globalsBySymbol.get(symbol)?.type : undefined;
    const optionalString = (candidate: IrType): boolean => candidate.kind === "union" &&
      L.unions.get(candidate.unionId)?.arms.length === 2 && L.armTag(candidate.unionId, STRING) >= 0 &&
      L.armTag(candidate.unionId, UNDEFINED_T) >= 0;
    if (actual && type.kind === "string" && optionalString(actual)) return actual;
    if (actual?.kind === "array" && type.kind === "array" && type.elem.kind === "string" && optionalString(actual.elem)) return actual;
    return type;
  }
  if (type.kind !== "array" || !ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression) ||
      value.expression.name.text !== "map" || !L.isStdlibMember(value.expression)) return type;
  const callback = value.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return type;
  const element = inferredRegexCaptureReturn(L, callback, type.elem);
  return element ? { kind: "array", elem: element } : type;
}
