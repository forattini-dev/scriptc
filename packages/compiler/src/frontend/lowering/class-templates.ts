/* CLASS TEMPLATES: a class expression evaluated inside a function body.
 *
 * Each evaluation of such an expression mints a DISTINCT class in JS (fresh
 * identity, its own captured environment). The shape is the same for every
 * evaluation, so the class collects ONCE as an ordinary IR class `T` (one
 * layout, one vtable, one set of method bodies). What differs per
 * evaluation is held by a synthetic standalone class `T%class`: one object
 * is allocated per evaluation and that object IS the class value, holding a
 * snapshot of every enclosing-function binding the members read.
 *
 *   - identity: `===` on two class values is object identity;
 *   - `new X(a)`: `new T(X, a)` — T's constructor takes the evaluation as a
 *     hidden parameter and stores it in the hidden `%template` field before
 *     anything else runs;
 *   - instance/constructor members read captures through prologue locals
 *     bound to the captured symbols, initialised from `this.%template`;
 *   - static methods take the evaluation as a hidden first parameter;
 *   - `v instanceof X`: the interval test against T and `v.%template === X`.
 *
 * The snapshot is exact only for bindings that cannot change after the
 * evaluation: consts, never-written parameters/lets/vars, and the
 * `let Ref; return (Ref = class …)` self-reference (which IS the evaluation
 * object). Everything else is a named refusal — never a silent divergence.
 * No IR node, validator rule or backend changes: templates are ordinary
 * classes, fields, calls and object identity. */
import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrFunction, IrLocal, IrParam, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { BOOL, STRING, VOID } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { findStaticOn, type ClassInfo } from "./lower-classes.js";
import { newFnCtx } from "./scope-env.js";
import { PoisonError, Lowerer as LowererClass } from "./lowerer.js";
import { mixinFnShapeOf } from "./lower-mixins.js";
import { classFactoryMethodOf } from "./class-factory-shapes.js";

/** The hidden instance field of a template class naming its evaluation. */
export const TEMPLATE_FIELD = "%template";

export interface TemplateCapture {
  symbol: ts.Symbol;
  /** Field on the evaluation object (absent for the self reference). */
  field: string | null;
  type: IrType;
  name: string;
  /** A reference inside the class body, lowered in the enclosing function
   * to read the binding's value at evaluation time. */
  ref: ts.Identifier;
}

export interface ClassTemplateInfo {
  /** IR name of the synthetic evaluation class (`T%class`). */
  objectClass: string;
  captures: TemplateCapture[];
  /** `Ref = class …`: the assignment whose dead store is elided. */
  selfAssignment?: ts.BinaryExpression;
}

function unparen(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** A class expression whose evaluation may repeat: it sits inside a
 * function-like body or a static block. */
export function isClassTemplateNode(expr: ts.ClassLikeDeclaration): expr is ts.ClassExpression {
  if (!ts.isClassExpression(expr)) return false;
  for (let p: ts.Node = expr.parent; !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return true;
  }
  return false;
}

export function templateObjectClassName(L: Lowerer, expr: ts.ClassExpression): string {
  return `${L.classNamer(expr)}%class`;
}

/** The `Ref = (class …)` assignment and `let Ref` binding of the self
 * reference pattern, or null. Pure (no diagnostics). */
function selfAssignmentOf(L: Lowerer, expr: ts.ClassExpression): { assign: ts.BinaryExpression; symbol: ts.Symbol } | null {
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (!ts.isBinaryExpression(parent) || parent.right !== node ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(parent.left)) return null;
  const symbol = L.checker.getSymbolAtLocation(parent.left);
  const decl = symbol ? L.checker.valueDeclarationOf(symbol) : undefined;
  if (!symbol || !decl || !ts.isVariableDeclaration(decl) || decl.initializer || !ts.isIdentifier(decl.name) ||
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Let) === 0) return null;
  return { assign: parent, symbol };
}

/** JS infers the self reference as `any`; a straight-line return of it is
 * exactly the evaluation object. */
export function classTemplateSelfReturnType(L: Lowerer, member: ts.MethodDeclaration): IrType | null {
  if (member.type || !member.body || !ts.isClassExpression(member.parent) || !isClassTemplateNode(member.parent)) return null;
  const statements = member.body.statements;
  const last = statements[statements.length - 1];
  if (!last || !ts.isReturnStatement(last) || !last.expression) return null;
  if (!statements.slice(0, -1).every(s => ts.isExpressionStatement(s) || ts.isVariableStatement(s) || ts.isEmptyStatement(s))) return null;
  const returned = unparen(last.expression);
  if (!ts.isIdentifier(returned)) return null;
  const self = selfAssignmentOf(L, member.parent);
  if (!self || L.checker.getSymbolAtLocation(returned) !== self.symbol) return null;
  return { kind: "object", className: templateObjectClassName(L, member.parent) };
}

/** Syntactic refusals, before the shape collects. */
export function fenceClassTemplate(L: Lowerer, expr: ts.ClassExpression): void {
  const refuse = (node: ts.Node, what: string): never =>
    L.unsupported("SC1090", node, `${what} in class expressions evaluated inside functions (each evaluation mints a distinct class)`);
  if (L.instantiationContext) refuse(expr, "generic instantiation contexts");
  for (const member of expr.members) {
    const isStatic = ts.canHaveModifiers(member) &&
      (ts.getModifiers(member) ?? []).some(m => m.kind === ts.SyntaxKind.StaticKeyword);
    if (ts.isClassStaticBlockDeclaration(member)) refuse(member, "static blocks");
    if (isStatic && ts.isPropertyDeclaration(member)) refuse(member, "static fields");
    if (isStatic && (ts.isGetAccessor(member) || ts.isSetAccessor(member))) refuse(member, "static accessors");
    const name = (member as { name?: ts.Node }).name;
    if (name && ts.isPrivateIdentifier(name)) refuse(member, "private names (their brand is per evaluation)");
    if (name && ts.isComputedPropertyName(name)) refuse(member, "computed member names");
  }
  if (expr.name) {
    const inner = L.checker.getSymbolAtLocation(expr.name);
    let used = false;
    ts.walkPreorder(expr, node => {
      if (node !== expr.name && ts.isIdentifier(node) && node.text === expr.name!.text &&
        L.checker.getSymbolAtLocation(node) === inner) { used = true; return "stop"; }
      return undefined;
    });
    if (used) refuse(expr.name, "references to the class's own inner name");
  }
}

function isWrite(node: ts.Identifier): boolean {
  let child: ts.Node = node;
  for (let p: ts.Node = node.parent; p; child = p, p = p.parent) {
    if (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) ||
      ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p) || ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p)) continue;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      return p.left === child && (op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment));
    }
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === child;
    return false;
  }
  return false;
}

function enclosingFunctionOf(node: ts.Node): ts.Node | null {
  for (let p: ts.Node = node.parent; !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return p;
  }
  return null;
}

function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

function isTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p && !ts.isClassExpression(p) && !ts.isClassDeclaration(p); p = p.parent) {
    if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isExpressionWithTypeArguments(p) ||
      ts.isTypeLiteralNode(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
  }
  return false;
}

/** Captures, the evaluation class, and the hidden field. Runs right after
 * the template's shape collected, before any subclass can copy its fields. */
export function admitClassTemplate(L: Lowerer, expr: ts.ClassExpression, info: ClassInfo): void {
  const refuse = (node: ts.Node, what: string): never =>
    L.unsupported("SC1090", node, `${what} (class expressions evaluated inside functions snapshot their captured bindings per evaluation)`);
  for (let base = info.base; base; base = base.base) {
    if (base.template || base.templateBase) {
      refuse(expr, "class expressions inside functions extending another per-evaluation class (a template over a template)");
    }
    if (base.builtinError || base.builtinEmitter || base.builtinStream !== undefined || base.generic || base.genericInstance) {
      refuse(expr, "class expressions inside functions extending builtin or generic bases");
    }
  }
  const objectClass = templateObjectClassName(L, expr);
  const self = selfAssignmentOf(L, expr);
  const captures: TemplateCapture[] = [];
  const bySymbol = new Map<ts.Symbol, TemplateCapture>();
  for (const member of expr.members) {
    ts.walkPreorder(member, node => {
      if (!ts.isIdentifier(node)) return undefined;
      const parent = node.parent;
      if ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
          ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) && parent.name === node) ||
        isTypePosition(node)) return undefined;
      const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node
        ? L.checker.getShorthandAssignmentValueSymbol(parent)
        : L.checker.getSymbolAtLocation(node);
      if (!symbol || (symbol.flags & ts.SymbolFlags.Value) === 0) return undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) return undefined; // imports are module-level
      const decl = L.checker.valueDeclarationOf(symbol);
      if (!decl || within(decl, expr) || decl.getSourceFile() !== expr.getSourceFile()) return undefined;
      const owner = enclosingFunctionOf(decl);
      if (!owner || !within(expr, owner)) return undefined; // module-level binding
      if (bySymbol.has(symbol)) return undefined;
      if (self && symbol === self.symbol) {
        const capture: TemplateCapture = { symbol, field: null, type: { kind: "object", className: objectClass }, name: node.text, ref: node };
        bySymbol.set(symbol, capture);
        captures.push(capture);
        return undefined;
      }
      if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) refuse(node, `capturing the local class '${node.text}'`);
      if (decl.getStart() > expr.getStart() && !ts.isFunctionDeclaration(decl)) {
        refuse(node, `capturing '${node.text}', declared after the class expression`);
      }
      const constBinding = ts.isVariableDeclaration(decl) && (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
      if (!constBinding) {
        let written = false;
        ts.walkPreorder(owner, inner => {
          if (ts.isIdentifier(inner) && inner.text === node.text && isWrite(inner) &&
            L.checker.getSymbolAtLocation(inner) === symbol) { written = true; return "stop"; }
          return undefined;
        });
        if (written) refuse(node, `capturing the reassigned binding '${node.text}'`);
      }
      const nameNode = (decl as { name?: ts.Node }).name ?? decl;
      const type = L.mapTypeOf(L.checker.getTypeOfSymbolAtLocation(symbol, nameNode)) ??
        refuse(node, `capturing '${node.text}' (its type has no lowering)`);
      const capture: TemplateCapture = { symbol, field: `${captures.length}.${node.text}`, type, name: node.text, ref: node };
      bySymbol.set(symbol, capture);
      captures.push(capture);
      return undefined;
    });
  }
  if (self) {
    // The elided store must be the binding's only use outside the class.
    const owner = enclosingFunctionOf(expr)!;
    ts.walkPreorder(owner, node => {
      if (ts.isIdentifier(node) && node !== self.assign.left && !within(node, expr) &&
        node.text === (self.assign.left as ts.Identifier).text && L.checker.getSymbolAtLocation(node) === self.symbol &&
        !ts.isVariableDeclaration(node.parent)) {
        refuse(node, `reading the class self-reference '${node.text}' outside the class body`);
      }
      return undefined;
    });
  }
  const objectFields = captures.filter(c => c.field !== null).map(c => ({ name: c.field!, type: c.type }));
  const objectInfo: ClassInfo = {
    def: { name: objectClass, jsName: info.def.jsName ?? "", fields: objectFields, loc: info.def.loc },
    fields: new Map(objectFields.map(f => [f.name, f.type])),
    fieldOrder: [],
    methods: new Map(),
    decl: null,
    ctor: null,
    ctorParams: [],
    base: null,
    subclasses: [],
    throwingSetters: [],
    staticFields: [],
    templateObjectOf: info,
  };
  L.classes.set(objectClass, objectInfo);
  L.exprClasses.push(objectInfo);
  const hidden: IrType = { kind: "object", className: objectClass };
  info.def.fields.push({ name: TEMPLATE_FIELD, type: hidden });
  info.fields.set(TEMPLATE_FIELD, hidden);
  info.template = { objectClass, captures, ...(self ? { selfAssignment: self.assign } : {}) };
}

function objectType(className: string): IrType {
  return { kind: "object", className };
}

/** One evaluation: allocate the evaluation object over the snapshot. */
export function lowerTemplateEvaluation(L: Lowerer, expr: ts.ClassExpression, info: ClassInfo): IrExpr {
  const template = info.template!;
  const loc = locOf(expr);
  L.noteEdge(`%${template.objectClass}.constructor`);
  L.noteEdge(`%${info.def.name}.constructor`);
  const args = template.captures.filter(c => c.field !== null).map(c => L.lowerExprExpecting(c.ref, c.type));
  return { kind: "new", className: template.objectClass, args, type: objectType(template.objectClass), loc };
}

/** `Ref = class …` with an unobservable store: the evaluation itself. */
export function lowerTemplateSelfAssignment(L: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(expr.left)) return null;
  const right = unparen(expr.right);
  if (!ts.isClassExpression(right) || !isClassTemplateNode(right) || !selfAssignmentOf(L, right)) return null;
  const info = L.lowerClassExpressionInfo(right);
  if (info.template?.selfAssignment !== expr) return null;
  return lowerTemplateEvaluation(L, right, info);
}

/** The evaluation class's constructor: one parameter per snapshot field. */
export function templateObjectCtor(L: Lowerer, info: ClassInfo): IrFunction {
  const loc = info.def.loc;
  const thisType = objectType(info.def.name);
  return L.env.inFunction(newFnCtx(false, null, null, VOID), () => {
    const thisLocal = L.declareThis(thisType);
    const params: IrParam[] = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const body: IrStmt[] = [];
    for (const field of info.def.fields) {
      const local = L.declareHiddenLocal(`cap${params.length}`, field.type);
      params.push({ localId: local.id, name: local.name, type: field.type });
      body.push({ kind: "fieldSet", obj: { kind: "varRef", localId: thisLocal.id, type: thisType, loc }, className: info.def.name,
        field: field.name, value: { kind: "varRef", localId: local.id, type: field.type, loc }, loc });
    }
    return { name: `%${info.def.name}.constructor`, params, returnType: VOID, locals: L.ctx.locals, body, loc };
  });
}

/** Binds every capture to a local of the current member, read from `env`. */
function capturePrologue(L: Lowerer, info: ClassInfo, env: () => IrExpr, loc: SrcLoc): IrStmt[] {
  const template = info.template!;
  const out: IrStmt[] = [];
  for (const capture of template.captures) {
    const local = L.env.declare(capture.symbol, capture.name, capture.type, false);
    const value: IrExpr = capture.field === null
      ? env()
      : { kind: "fieldGet", obj: env(), className: template.objectClass, field: capture.field, type: capture.type, loc };
    out.push({ kind: "varDecl", localId: local.id, init: value, loc });
  }
  return out;
}

function templateFieldOf(info: ClassInfo, thisLocal: IrLocal, loc: SrcLoc): IrExpr {
  return {
    kind: "fieldGet", obj: { kind: "varRef", localId: thisLocal.id, type: objectType(info.def.name), loc },
    className: info.def.name, field: TEMPLATE_FIELD, type: objectType(info.template!.objectClass), loc,
  };
}

/** Instance members: captures read through `this.%template`. */
export function templateMethodPrologue(L: Lowerer, info: ClassInfo, thisLocal: IrLocal, loc: SrcLoc): IrStmt[] {
  if (!info.template) return [];
  return capturePrologue(L, info, () => templateFieldOf(info, thisLocal, loc), loc);
}

/** The constructor: the hidden evaluation parameter is stored before
 * anything else (default parameters, super(), field initializers). */
export function templateCtorPrologue(L: Lowerer, info: ClassInfo, thisLocal: IrLocal, params: IrParam[], loc: SrcLoc): IrStmt[] {
  if (!info.template) return [];
  const type = objectType(info.template.objectClass);
  const env = L.declareHiddenLocal(TEMPLATE_FIELD, type);
  params.push({ localId: env.id, name: env.name, type });
  const read = (): IrExpr => ({ kind: "varRef", localId: env.id, type, loc });
  return [
    { kind: "fieldSet", obj: { kind: "varRef", localId: thisLocal.id, type: objectType(info.def.name), loc },
      className: info.def.name, field: TEMPLATE_FIELD, value: read(), loc },
    ...capturePrologue(L, info, read, loc),
  ];
}

/** Static methods: the evaluation is a hidden first parameter. */
export function templateStaticPrologue(L: Lowerer, info: ClassInfo, params: IrParam[], loc: SrcLoc): IrStmt[] {
  if (!info.template) return [];
  const type = objectType(info.template.objectClass);
  const env = L.declareHiddenLocal(TEMPLATE_FIELD, type);
  params.push({ localId: env.id, name: env.name, type });
  return capturePrologue(L, info, () => ({ kind: "varRef", localId: env.id, type, loc }), loc);
}

/** The template whose evaluation objects have IR type `type`, if any. */
export function templateOfObjectType(L: Lowerer, type: IrType | null | undefined): ClassInfo | null {
  if (type?.kind !== "object") return null;
  return L.classes.get(type.className)?.templateObjectOf ?? null;
}

/** For a static class whose chain reaches a template (`class D extends
 * f()`), the module global holding that template's evaluation. */
export function templateEnvOfStaticChain(info: ClassInfo, declarer: ClassInfo, loc: SrcLoc): IrExpr | null {
  if (!declarer.template) return null;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.templateBase && c.base === declarer) {
      return { kind: "varRef", localId: c.templateBase.globalId, type: objectType(declarer.template.objectClass), loc };
    }
  }
  return null;
}

/** `X.name` for an evaluation: NamedEvaluation is fixed per template. */
export function templateNameRead(L: Lowerer, receiver: IrExpr, template: ClassInfo, loc: SrcLoc): IrExpr {
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: receiver, loc }],
    result: { kind: "strLit", value: template.def.jsName ?? "", type: STRING, loc },
    type: STRING,
    loc,
  };
}

/** The type mapper's view of a template node: collected on demand (the
 * generic-instance precedent), named deterministically while collecting.
 * A refused collection answers null and reports its diagnostics to the
 * declaration that needed the type (a silent probe only asks). The class
 * node of a recognized mixin/factory shape belongs to that machinery. */
export function classTemplateNamesOf(L: Lowerer, decl: ts.ClassLikeDeclaration, silent = false): { instance: string; object: string } | null {
  if (!isClassTemplateNode(decl)) return null;
  const owner = enclosingFunctionOf(decl);
  // A builder method's class: when refused, the method keeps the per-site
  // specialization path (lower-classes skips it), which owns the fences.
  if (owner && ts.isMethodDeclaration(owner) && classFactoryMethodOf(L, owner)?.classNode === decl) silent = true;
  const failed = templateProbeFailures.get(L)?.get(decl);
  if (failed) {
    if (!silent) for (const diagnostic of failed) L.pushDiag(diagnostic);
    return null;
  }
  const names = { instance: L.classNamer(decl), object: templateObjectClassName(L, decl) };
  if (L.collectingExprClasses.has(decl)) return names;
  const cached = L.exprClassInfoByNode.get(decl);
  if (cached) return cached.template ? names : null;
  if (owner && (ts.isFunctionDeclaration(owner) || ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
    mixinFnShapeOf(L, owner)?.classNode === decl) return null;
  const saved = L.diagSink;
  const captured: typeof L.diags = [];
  L.diagSink = captured;
  try {
    const info = L.lowerClassExpressionInfo(decl);
    L.diagSink = saved;
    for (const diagnostic of captured) L.pushDiag(diagnostic);
    return info.template ? names : null;
  } catch (e) {
    L.diagSink = saved;
    if (!(e instanceof PoisonError)) throw e;
    const failures = templateProbeFailures.get(L) ?? new Map();
    failures.set(decl, captured);
    templateProbeFailures.set(L, failures);
    // The refusal belongs to whatever declaration needed this type (its
    // deferral sink decides when it reports); a silent probe only asks.
    if (!silent) for (const diagnostic of captured) L.pushDiag(diagnostic);
    return null;
  }
}

const templateProbeFailures = new WeakMap<Lowerer, Map<ts.ClassLikeDeclaration, LowererClass["diags"]>>();

/** `X.m(args)` with X an evaluation: an own static takes X as its hidden
 * environment; a static inherited from the (static) base calls directly. */
export function lowerTemplateStaticCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression,
  template: ClassInfo): IrExpr {
  const loc = locOf(call);
  const name = access.name.text;
  const found = findStaticOn(L, template, name);
  if (!found || found.method === undefined) {
    L.unsupported("SC1090", call, `the static member '${name}' through the value of a class evaluated inside a function (static fields and accessors have no per-evaluation lowering)`);
  }
  const receiver = L.lowerExpr(access.expression);
  const callee = `%${found.declarer.def.name}.static:${name}`;
  L.noteEdge(callee);
  const args = L.completeArgs(call.arguments, found.method.params, loc, call);
  if (found.declarer === template) return { kind: "call", callee, args: [receiver, ...args], type: found.method.ret, loc };
  return {
    kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: receiver, loc }],
    result: { kind: "call", callee, args, type: found.method.ret, loc }, type: found.method.ret, loc,
  };
}

/** `v instanceof X` with X an evaluation. A value statically of the
 * template (or a subclass) is an instance of exactly the evaluation in its
 * hidden field; an unrelated static class is never one. */
export function lowerTemplateInstanceof(L: Lowerer, expr: ts.BinaryExpression, template: ClassInfo): IrExpr {
  const loc = locOf(expr);
  const left = L.lowerExpr(expr.left);
  const right = L.lowerExpr(expr.right);
  if (left.type.kind !== "object" || !L.classes.has(left.type.className)) {
    L.unsupported("SC1090", expr, "'instanceof' a class evaluated inside a function on values other than class instances");
  }
  const lhs = left.type.className;
  if (lhs === template.def.name || L.isSubclassOf(lhs, template.def.name)) {
    const value: IrExpr = {
      kind: "fieldGet", obj: L.upcastTo(left, template.def.name), className: template.def.name,
      field: TEMPLATE_FIELD, type: objectType(template.template!.objectClass), loc,
    };
    return { kind: "bin", op: "===", left: value, right, type: BOOL, loc };
  }
  if (L.isSubclassOf(template.def.name, lhs)) {
    L.unsupported("SC1090", expr, "'instanceof' a class evaluated inside a function on a base-typed value (narrow to the class first)");
  }
  return {
    kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: left, loc }, { kind: "exprStmt", expr: right, loc }],
    result: { kind: "boolLit", value: false, type: BOOL, loc }, type: BOOL, loc,
  };
}

/** `class D extends <expr>`: the template whose evaluation the heritage
 * provably yields — the checker's type of the expression is exactly that
 * template's static side (one class; never a union, never any), so its IR
 * type is the evaluation class, which only evaluating the template can
 * produce. Null when the heritage is not a template evaluation; a template
 * heritage in an unsupported position is a named refusal. */
export function templateHeritageBaseOf(L: Lowerer, decl: ts.ClassLikeDeclaration, heritage: ts.Expression): ClassInfo | null {
  const type = L.typeOf(heritage);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union)) return null;
  const symbol = type.getSymbol();
  const declared = symbol ? L.checker.valueDeclarationOf(symbol) : undefined;
  if (!declared || !ts.isClassExpression(declared) || !isClassTemplateNode(declared)) return null;
  const template = L.checker.getConstructSignatures(type).length > 0 ? templateOfObjectType(L, L.mapTypeOf(type)) : null;
  if (!template) {
    const reason = templateProbeFailures.get(L)?.get(declared)?.[0]?.message.replace(/ (is|are) not supported yet$/, "");
    L.unsupported("SC1090", heritage, `extending a class evaluated inside a function whose template was refused${reason ? ` (${reason})` : ""}`);
  }
  if (!ts.isClassDeclaration(decl) || !ts.isSourceFile(decl.parent)) {
    L.unsupported("SC1090", heritage, "extending a class evaluated inside a function from a class that may itself evaluate more than once (declare the derived class at top level)");
  }
  return template;
}

export function registerTemplateHeritage(L: Lowerer, info: ClassInfo, heritage: ts.Expression): void {
  const template = info.base!.template!;
  const global = { id: `%g.${info.def.name}.%base`, name: `${info.def.jsName ?? info.def.name}.%base`,
    type: objectType(template.objectClass), mutable: true };
  L.globalsList.push(global);
  info.templateBase = { globalId: global.id, expr: heritage };
}

/** The heritage evaluates at the class statement, before its statics. */
export function templateHeritageInit(L: Lowerer, info: ClassInfo): IrStmt[] {
  const heritage = info.templateBase;
  if (!heritage) return [];
  const loc = locOf(heritage.expr);
  const type = objectType(info.base!.template!.objectClass);
  const value = L.lowerExpr(heritage.expr);
  if (value.type.kind !== "object" || value.type.className !== info.base!.template!.objectClass) {
    L.unsupported("SC1090", heritage.expr, "extending an expression whose lowering is not exactly one evaluation of a class template");
  }
  return [{ kind: "assign", localId: heritage.globalId, value: { ...value, type }, loc }];
}
