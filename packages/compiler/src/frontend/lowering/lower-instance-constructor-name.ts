import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { BOOL, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

/** Descendants precede ancestors: instanceof tests match an entire subtree. */
function family(info: ClassInfo): ClassInfo[] {
  return [...info.subclasses.flatMap(family), ...(!info.generic ? [info] : [])];
}

function refusal(candidates: readonly ClassInfo[], identity = false): string | null {
  for (const candidate of candidates) {
    if (candidate.fields.has("constructor") || candidate.methods.has("constructor") || candidate.methods.has("get:constructor") || candidate.methods.has("set:constructor")) {
      return "instance constructor names in a hierarchy with a shadowed constructor property";
    }
    if (identity) continue;
    const staticOwner = candidate.genericInstance?.family ?? candidate;
    const nameField = staticOwner.staticFields.find(field => field.name === "name");
    if (nameField && nameField.type.kind !== "string") return "instance constructor names with non-string static name fields";
    if (!nameField && candidate.decl?.members.some(member =>
      (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
      member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
      (ts.isComputedPropertyName(member.name) || ((ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === "name")),
    )) {
      return "instance constructor names in a hierarchy with a shadowed static name";
    }
  }
  return null;
}

function dispatchBody(info: ClassInfo, loc: SrcLoc, identity = false): IrStmt[] {
  const value: IrExpr = { kind: "varRef", localId: "value.0", type: { kind: "object", className: info.def.name }, loc };
  const name = (candidate: ClassInfo): IrExpr => {
    if (identity) return { kind: "strLit", value: `%${candidate.def.name}.constructor`, type: STRING, loc };
    // Every class has its OWN name property, so an ancestor's static name
    // field never overrides the default name of an ordinary descendant.
    const staticOwner = candidate.genericInstance?.family ?? candidate;
    const field = staticOwner.staticFields.find(member => member.name === "name");
    if (field) return { kind: "varRef", localId: field.globalId, type: field.type, loc };
    return { kind: "strLit", value: candidate.def.jsName ?? candidate.def.name.replace(/^%/, ""), type: STRING, loc };
  };
  return [
    ...family(info).filter(candidate => candidate !== info).map((candidate): IrStmt => ({
      kind: "if", cond: { kind: "instanceOf", value, className: candidate.def.name, type: BOOL, loc },
      then: [{ kind: "return", value: name(candidate), loc }], else_: null, loc,
    })),
    { kind: "return", value: name(info), loc },
  ];
}

/** A capture-only identity token, never the mutable constructor.name. */
export function lowerInstanceConstructorId(lowerer: Lowerer, ctor: ts.PropertyAccessExpression): IrExpr | null {
  if (ctor.name.text !== "constructor" || ctor.questionDotToken || !lowerer.isStdlibMember(ctor)) return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(ctor.expression));
  if (type?.kind !== "object") return null;
  const info = lowerer.classes.get(type.className);
  if (!info) return null;
  const reason = refusal(family(info), true);
  if (reason) lowerer.unsupported("SC1090", ctor, reason);
  const loc = locOf(ctor);
  const key = `%instance.constructor.id:${info.def.name}`;
  if (!lowerer.arrHofHelpers.has(key)) {
    lowerer.arrHofHelpers.set(key, key);
    lowerer.liftedFns.push({ name: key, params: [{ localId: "value.0", name: "value", type }], returnType: STRING,
      locals: [{ id: "value.0", name: "value", type, mutable: false }], body: dispatchBody(info, loc, true), loc });
  }
  return { kind: "call", callee: key, args: [lowerer.lowerExpr(ctor.expression)], type: STRING, loc };
}

/** Claim only the inherited Object constructor property. Own constructor
 * fields/accessors keep ordinary property lowering; descendant shadows must
 * not silently turn into native class metadata. */
export function lowerInstanceConstructorName(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.name.text !== "name" || expr.questionDotToken || !ts.isPropertyAccessExpression(expr.expression)) return null;
  const ctor = expr.expression;
  if (ctor.name.text !== "constructor" || ctor.questionDotToken || !lowerer.isStdlibMember(ctor)) return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(ctor.expression));
  if (type?.kind !== "object") return null;
  const info = lowerer.classes.get(type.className);
  if (!info) return null;
  const reason = refusal(family(info));
  if (reason) lowerer.unsupported("SC1090", expr, reason);
  const loc = locOf(expr);
  const key = `%instance.constructor.name:${info.def.name}`;
  if (!lowerer.arrHofHelpers.has(key)) {
    lowerer.arrHofHelpers.set(key, key);
    lowerer.liftedFns.push({
      name: key, params: [{ localId: "value.0", name: "value", type }], returnType: STRING,
      locals: [{ id: "value.0", name: "value", type, mutable: false }], body: dispatchBody(info, loc), loc,
    });
  }
  return { kind: "call", callee: key, args: [lowerer.lowerExpr(ctor.expression)], type: STRING, loc };
}

/** Class expressions and generic instances may be collected after the first
 * read. Refresh against the completed graph before module retention. This
 * dispatcher introduces no constructor or method reachability edges. */
export function refreshInstanceConstructorNames(lowerer: Lowerer): void {
  for (const fn of lowerer.liftedFns) {
    const identity = fn.name.startsWith("%instance.constructor.id:");
    if (!identity && !fn.name.startsWith("%instance.constructor.name:")) continue;
    const type = fn.params[0]?.type;
    if (type?.kind !== "object") continue;
    const info = lowerer.classes.get(type.className);
    if (!info) continue;
    const reason = refusal(family(info), identity);
    if (reason) lowerer.pushDiag(unsupportedDiag("SC1090", fn.loc, reason));
    else fn.body = dispatchBody(info, fn.loc, identity);
  }
}
