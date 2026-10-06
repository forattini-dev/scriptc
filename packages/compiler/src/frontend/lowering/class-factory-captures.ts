import * as ts from "../ts7/adapter.js";
import { DYN, type IrGlobal, type IrStmt, type IrType } from "../../ir/ir.js";
import { isJsSourceFile, isNodeEsmFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import type { MixinFnShape } from "./lower-mixins.js";
import { probeExactInstanceClassOf } from "./lower-class-bindings.js";
import { findGenericMethodOn } from "./lower-classes.js";
import { implicitMethodMayBeOverridden } from "./implicit-method-overrides.js";

export interface ClassFactoryCaptures {
  slots: Map<ts.Symbol, IrGlobal>;
  arguments: IrGlobal[];
  receiver?: { slot: IrGlobal; expression: ts.NewExpression };
  self?: IrGlobal;
}

/** Reserve one mutable parameter cell per call, never one per factory AST. */
export function prepareClassFactoryCaptures(L: Lowerer, call: ts.CallExpression, shape: MixinFnShape,
  name: string): ClassFactoryCaptures {
  const parameters = shape.factory?.parameters ?? [];
  if (call.arguments.length !== parameters.length || call.arguments.some(ts.isSpreadElement) ||
    parameters.some(p => !ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer)) {
    L.unsupported("SC1090", call, "class factories with default, optional, rest, destructured or non-exact arguments");
  }
  const holder = classFactoryStatementOf(call);
  if (!holder) L.unsupported("SC1090", call,
    "class factories outside a single top-level const initializer or class heritage (each evaluation must mint a distinct class)");
  if (call.getSourceFile() !== L.entry && !isNodeEsmFile(call.getSourceFile())) {
    L.unsupported("SC1090", call, "class factories in reloadable CommonJS modules (a failed require may repeat this call)");
  }
  const binding = shape.fn.parent;
  if (ts.isVariableDeclaration(binding) && binding.getSourceFile() === call.getSourceFile() &&
    binding.getStart() >= call.getStart()) {
    L.unsupported("SC1090", call, "class factory calls before their const binding initializes (temporal dead zone)");
  }
  const baseSymbol = shape.factory ? L.resolveValueSymbol(shape.factory.base) : null;
  const baseDeclaration = baseSymbol ? L.checker.valueDeclarationOf(baseSymbol) : undefined;
  if (baseDeclaration && baseDeclaration.getSourceFile() === call.getSourceFile() &&
    baseDeclaration.getStart() >= call.getStart()) {
    L.unsupported("SC1090", call, "class factory calls before their base class initializes (temporal dead zone)");
  }
  const captures: ClassFactoryCaptures = { slots: new Map(), arguments: [] };
  for (const [index, parameter] of parameters.entries()) {
    if (!ts.isIdentifier(parameter.name)) throw new Error("checked class factory parameter");
    const symbol = L.checker.getSymbolAtLocation(parameter.name);
    if (!symbol) L.unsupported("SC1090", parameter, "class factory parameters without a binding");
    const sourceType = L.typeOf(parameter);
    const type = isJsSourceFile(shape.fn.getSourceFile()) && !parameter.type ? DYN : L.mapTypeOf(sourceType);
    if (!type) L.badType(parameter, sourceType);
    const global: IrGlobal = { id: `%g.${name}.capture${index}`, name: parameter.name.text, type, mutable: true };
    captures.slots.set(symbol, global);
    captures.arguments.push(global);
    L.globalsList.push(global);
  }
  const method = shape.factory?.method;
  if (method) {
    if (method.owner.getSourceFile() === call.getSourceFile() && method.owner.getStart() >= call.getStart()) {
      L.unsupported("SC1090", call, "class factory calls before their builder class initializes (temporal dead zone)");
    }
    const ownerSymbol = method.owner.name ? L.resolveValueSymbol(method.owner.name) : null;
    const owner = ownerSymbol ? L.classBySymbol.get(ownerSymbol) : undefined;
    const methodName = method.declaration.name.getText();
    // Not skipped at collection (a template-returning method is ordinary)
    // is fine; only inherited/overridable or field-shadowed members fence.
    if (!owner || owner.fields.has(methodName) || L.findMethodOn(owner.base, methodName) ||
      findGenericMethodOn(L, owner.base, methodName) || implicitMethodMayBeOverridden(L, methodName)) {
      L.unsupported("SC1090", call, "class factory wrappers without a closed, non-overridden builder method");
    }
    const closureSymbol = L.checker.getSymbolAtLocation(method.closure.name);
    if (!closureSymbol) L.unsupported("SC1090", method.closure, "class factory receiver aliases without a binding");
    const slot: IrGlobal = { id: `%g.${name}.receiver`, name: method.closure.name.getText(),
      type: { kind: "object", className: owner.def.name }, mutable: false };
    captures.slots.set(closureSymbol, slot);
    captures.receiver = { slot, expression: method.receiver };
    L.globalsList.push(slot);
    if (method.self) {
      // A static initializer could indirectly call a member before this
      // assignment. Preserve a named boundary until undefined-armed class
      // cells and their observable initialization order are modeled.
      if (shape.classNode.members.some(member => ts.isClassStaticBlockDeclaration(member) ||
        (ts.isPropertyDeclaration(member) && member.initializer &&
          member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)))) {
        L.unsupported("SC1090", call, "self-referencing class factories with static initializers before the class assignment");
      }
      const selfSymbol = L.checker.getSymbolAtLocation(method.self.name);
      if (!selfSymbol) L.unsupported("SC1090", method.self, "class factory self-references without a binding");
      const self: IrGlobal = { id: `%g.${name}.self`, name: method.self.name.getText(),
        type: { kind: "classval", className: name }, mutable: true };
      captures.slots.set(selfSymbol, self);
      captures.self = self;
      L.globalsList.push(self);
    }
  }
  return captures;
}

/** Arguments precede base evaluation and every static initializer. */
export function classFactoryArgumentInits(L: Lowerer, info: ClassInfo): IrStmt[] {
  const instance = info.mixinInstance;
  if (!instance?.factory) return [];
  const statements: IrStmt[] = instance.factory.arguments.map((slot, index) => {
    const argument = instance.call.arguments[index];
    if (!argument) throw new Error("checked class factory argument count");
    return { kind: "assign", localId: slot.id, value: L.lowerExprExpecting(argument, slot.type), loc: locOf(argument) };
  });
  const receiver = instance.factory.receiver;
  if (receiver) statements.push(withClassFactoryCaptures(L, info, () => ({
    kind: "assign", localId: receiver.slot.id,
    value: L.lowerExprExpecting(receiver.expression, receiver.slot.type), loc: locOf(receiver.expression),
  })));
  return statements;
}

export function classFactorySelfInit(L: Lowerer, info: ClassInfo): IrStmt[] {
  const self = info.mixinInstance?.factory?.self;
  if (!self || !info.decl) return [];
  return [{ kind: "assign", localId: self.id, value: L.classValueRef(info, info.decl), loc: locOf(info.decl) }];
}

/** JS infers the assigned local class reference as any. A straight-line
 * return of a captured class cell has a precise per-instantiation ABI;
 * preceding expressions/declarations still lower normally, with their effects. */
export function classFactoryReturnType(L: Lowerer, member: ts.MethodDeclaration): IrType | null {
  if (member.type || !member.body) return null;
  const statements = member.body.statements;
  if (!statements.slice(0, -1).every(statement => ts.isExpressionStatement(statement) ||
    ts.isVariableStatement(statement) || ts.isEmptyStatement(statement))) return null;
  const statement = statements[statements.length - 1];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return null;
  let expression = statement.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isIdentifier(expression)) return null;
  const symbol = L.checker.getSymbolAtLocation(expression);
  const slot = symbol ? L.classFactoryCaptures?.get(symbol) : undefined;
  return slot?.type.kind === "classval" ? slot.type : null;
}

export function withClassFactoryCaptures<T>(L: Lowerer, info: ClassInfo, run: () => T): T {
  const captures = info.mixinInstance?.factory;
  if (!captures) return run();
  const previous = L.classFactoryCaptures;
  L.classFactoryCaptures = captures.slots;
  try { return run(); } finally { L.classFactoryCaptures = previous; }
}

export function classFactoryStatementOf(call: ts.CallExpression): ts.Statement | null {
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node &&
    ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Const) !== 0 &&
    parent.parent.declarations.length === 1 && ts.isVariableStatement(parent.parent.parent) &&
    ts.isSourceFile(parent.parent.parent.parent)) return parent.parent.parent;
  if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent) &&
    ts.isClassDeclaration(parent.parent.parent) && ts.isSourceFile(parent.parent.parent.parent)) return parent.parent.parent;
  return null;
}

/** The shared checker class node cannot distinguish two factory results.
 * A const's concrete new-expression can; never guess from that shared type. */
export function classFactoryInstanceBindingType(L: Lowerer, decl: ts.VariableDeclaration): IrType | null {
  if (decl.type || !decl.initializer || !ts.isIdentifier(decl.name) ||
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return null;
  const info = probeExactInstanceClassOf(L, decl.initializer);
  return info?.mixinInstance?.factory ? { kind: "object", className: info.def.name } : null;
}
