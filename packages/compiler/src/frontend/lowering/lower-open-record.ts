import { lowerNativeTupleArrayEquality } from "./lower-native-tuple.js";
import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr, type IrType } from "../../ir/nodes.js";
import { nativeRecordCheckSupported } from "../../ir/native-record.js";
import { locOf } from "../program.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";

/** Delete an own key from a proven plain JS dictionary. The checked map
 * view retains the object; configurable data keys return true even absent. */
export function lowerOpenRecordDelete(L: Lowerer, expr: ts.DeleteExpression): IrExpr | null {
  let target = expr.expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (!ts.isElementAccessExpression(target) && !ts.isPropertyAccessExpression(target)) return null;
  const source = L.typeOf(target.expression);
  const symbol = source.getSymbol();
  if (!symbol || !L.checker.declarationsOf(symbol).some(decl =>
    ts.isObjectLiteralExpression(decl) && decl.properties.length === 0 && /\.[cm]?js$/.test(decl.getSourceFile().fileName))) return null;
  const value = L.lowerExpr(target.expression);
  if (value.type.kind !== "dyn") return null;
  const loc = locOf(expr);
  const key: IrExpr = ts.isPropertyAccessExpression(target) ?
    { kind: "strLit", value: target.name.text, type: STRING, loc } : L.ensureString(L.lowerExpr(target.argumentExpression), target.argumentExpression);
  const shapeId = L.shapes.intern([], false, DYN);
  const type: IrType = { kind: "record", shapeId };
  const obj: IrExpr = { kind: "dynCheck", value, type, loc };
  const helperKey = `record.open.delete:${shapeId}`;
  let helper = L.arrHofHelpers.get(helperKey);
  if (!helper) {
    helper = `%record.open.delete.${L.arrHofHelpers.size}`;
    const params = [{ localId: "r.0", name: "r", type }, { localId: "k.0", name: "k", type: STRING }];
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    L.liftedFns.push({ name: helper, params,
      locals: params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
      returnType: BOOL, body: [
        { kind: "recordKeyDelete", obj: ref("r.0", type), shapeId, key: ref("k.0", STRING), loc },
        { kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
      ], loc });
    L.arrHofHelpers.set(helperKey, helper);
  }
  return { kind: "call", callee: helper, args: [obj, key], type: BOOL, loc };
}

/** Compare native views with their dynamic source using the shared identity. */
export function lowerNativeRecordDynamicEquality(L: Lowerer, left: IrExpr, right: IrExpr, negated: boolean): IrExpr | null {
  const tuple = lowerNativeTupleArrayEquality(L, left, right, negated);
  if (tuple) return tuple;
  const typed = left.type.kind === "dyn" ? right : left;
  const dynamic = typed === left ? right : left;
  if (dynamic.type.kind !== "dyn" || typed.type.kind !== "record" ||
    !nativeRecordCheckSupported(typed.type, id => L.shapes.get(id), id => L.unions.get(id))) return null;
  const boxed: IrExpr = { kind: "dynFrom", value: typed, type: DYN, loc: typed.loc };
  return { kind: "dynScalarEq", left: typed === left ? boxed : left,
    right: typed === right ? boxed : right, ...(negated ? { negated: true as const } : {}), type: BOOL, loc: left.loc };
}

/** A direct throw-only call has no value to box, but must still execute.
 * Do not generalize this to arbitrary void callbacks: they can hide values. */
export function lowerThrowingDynamicValue(L: Lowerer, node: ts.Expression, value: IrExpr): IrExpr {
  if (value.type.kind !== "void" || value.kind !== "call" || !ts.isCallExpression(node)) return L.coerceToExpected(value, DYN);
  const sig = L.checker.getResolvedSignature(node);
  const decl = sig ? L.checker.signatureDeclaration(sig) : undefined;
  if (!decl || !ts.isFunctionDeclaration(decl) || !decl.body) return value;
  const last = decl.body.statements[decl.body.statements.length - 1];
  if (!last || !ts.isThrowStatement(last)) return value;
  let valuedReturn = false;
  const visit = (part: ts.Node): void => {
    if (ts.isFunctionDeclaration(part) || ts.isFunctionExpression(part) || ts.isArrowFunction(part)) return;
    if (ts.isReturnStatement(part) && part.expression) valuedReturn = true;
    ts.forEachChild(part, visit);
  };
  visit(decl.body);
  if (valuedReturn) return value;
  return { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
    result: dynUndefinedExpr(value.loc), type: DYN, loc: value.loc };
}

/** A generic schema key reads the current shared object before checking its
 * declared record union. A missing own key remains an explicit undefined. */
export function lowerSharedRecordKeyRead(
  L: Lowerer, expr: ts.ElementAccessExpression, object: IrExpr, key: IrExpr,
): IrExpr | null {
  const supported = (type: IrType) => nativeRecordCheckSupported(type, id => L.shapes.get(id), id => L.unions.get(id));
  let target = L.mapTypeOf(L.typeOf(expr));
  if (!target || !supported(target) || !supported(object.type) || !L.dynConvertible(object.type)) return null;
  target = L.withUndefinedArmOf(target);
  if (!target) return null;
  const loc = locOf(expr);
  const value: IrExpr = { kind: "dynFrom", value: object, type: DYN, loc };
  const read: IrExpr = { kind: "dynKeyGet", value, key, type: DYN, loc };
  return { kind: "dynCheck", value: read, type: target, loc };
}
