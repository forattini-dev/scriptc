import * as ts from "../ts7/adapter.js";
import { BOOL, STRING, UNDEFINED_T, isUnitType, shapeHasAccessorSlots, typeKey, type IrExpr, type IrType, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { activeRuntimeTarget } from "../../compat/runtime-target.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";

function whichMember(L: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  if (!L.nativeDenseArrays || activeRuntimeTarget().family !== "bun" || !ts.isPropertyAccessExpression(node) ||
      node.questionDotToken || node.name.text !== "which") return false;
  if (L.isStdlibGlobal(node.expression, "Bun")) return true;
  // bun-types' real global is `export import Bun = BunModule`, whose alias
  // resolves to the ambient "bun" module rather than a namespace named Bun.
  let receiver = node.expression;
  while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
  const name = ts.isIdentifier(receiver) ? receiver : ts.isPropertyAccessExpression(receiver) &&
    !receiver.questionDotToken && L.isStdlibGlobal(receiver.expression, "globalThis") ? receiver.name : null;
  if (!name || name.text !== "Bun") return false;
  const symbol = L.checker.getSymbolAtLocation(name);
  if (!symbol || !L.isStdlibSymbol(symbol)) return false;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(symbol) : symbol;
  return L.isStdlibSymbol(resolved) && L.checker.declarationsOf(resolved).some(decl =>
    ts.isModuleDeclaration(decl) && ts.isStringLiteral(decl.name) && decl.name.text === "bun");
}

/** Project typed options only after the command and complete options expression have evaluated. */
function whichCall(L: Lowerer, command: IrExpr, options: IrExpr, result: IrType, blame: ts.Node): IrExpr {
  const loc = command.loc, optional = L.withUndefinedArm(STRING);
  const absent = (): IrExpr => L.wrappedUndefined(optional, loc) ?? L.noLowering("Bun.which optional string", blame);
  const field = (value: IrExpr, name: string): IrExpr => {
    if (isUnitType(value.type) || value.type.kind === "void") return absent();
    if (value.type.kind === "union") {
      const def = L.unions.get(value.type.unionId);
      if (!def) L.noLowering("Bun.which options union", blame);
      if (def.arms.every(isUnitType)) return absent();
      const present = def.arms.findIndex(arm => arm.kind === "record");
      const presentType = def.arms[present];
      const missing = L.armTag(value.type.unionId, UNDEFINED_T);
      if (def.arms.length !== 2 || !presentType || missing < 0) L.noLowering("Bun.which options", blame);
      const narrowed: IrExpr = { kind: "unionNarrow", value, unionId: value.type.unionId, tag: present, type: presentType, loc };
      return { kind: "ternary", cond: { kind: "unionIsTag", value, unionId: value.type.unionId, tag: missing, negated: false, type: BOOL, loc }, then: absent(), else_: field(narrowed, name), type: optional, loc };
    }
    if (value.type.kind !== "record") L.noLowering("Bun.which options", blame, "a typed options record with optional string PATH and cwd fields is supported");
    const shape = L.shapes.get(value.type.shapeId);
    if (!shape) L.noLowering("Bun.which options record", blame);
    if (shape.indexValue || shapeHasAccessorSlots(shape)) L.noLowering("Bun.which options with accessors or an index signature", blame);
    const slot = shape.fields.find(candidate => candidate.name === name);
    if (!slot) return absent();
    const read: IrExpr = { kind: "recordGet", obj: value, shapeId: shape.id, field: name, type: slot.type, loc };
    if (slot.type.kind === "union" && L.unions.get(slot.type.unionId)?.arms.every(arm => arm.kind === "undefinedT" || arm.kind === "nullT")) {
      return { kind: "ternary", cond: { kind: "unionIsTag", value: read, unionId: slot.type.unionId, tag: L.armTag(slot.type.unionId, UNDEFINED_T), negated: false, type: BOOL, loc }, then: absent(), else_: L.coerceToExpected({ kind: "strLit", value: "null", type: STRING, loc }, optional), type: optional, loc };
    }
    if (slot.type.kind !== "string" && slot.type.kind !== "undefinedT" &&
        (slot.type.kind !== "union" || L.unions.get(slot.type.unionId)?.arms.some(arm => arm.kind !== "string" && arm.kind !== "undefinedT"))) {
      L.noLowering(`Bun.which options.${name}`, blame, "a string or undefined is supported");
    }
    return L.coerceToExpected(read, optional);
  };
  return { kind: "libCall", fn: "bun.which", args: [command, field(options, "PATH"), field(options, "cwd")], type: result, loc };
}

export function lowerBunWhichCall(L: Lowerer, call: ts.CallExpression, callee: ts.Expression): IrExpr | null {
  if (!whichMember(L, callee)) return null;
  if (call.arguments.length < 1 || call.arguments.length > 2 || call.arguments.some(ts.isSpreadElement)) L.noLowering("Bun.which call arguments", call);
  const loc = locOf(call), result = L.irTypeOf(call);
  const commandNode = call.arguments[0];
  if (!commandNode) L.noLowering("Bun.which without a command", call);
  const command = L.lowerExprExpecting(commandNode, STRING);
  const options: IrExpr = call.arguments[1] ? L.lowerExpr(call.arguments[1]) : { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
  const source = L.declareHiddenLocal("%whichCommand", STRING);
  const opts = isUnitType(options.type) || options.type.kind === "void" ? null : L.declareHiddenLocal("%whichOptions", options.type);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: source.id, init: command, loc }];
  if (opts) stmts.push({ kind: "varDecl", localId: opts.id, init: options, loc });
  else if (!isSafeToDiscard(options)) stmts.push({ kind: "exprStmt", expr: options, loc });
  return {
    kind: "seqExpr", stmts,
    result: whichCall(L, varRef(source.id, STRING, loc), opts ? varRef(opts.id, options.type, loc) : options, result, call),
    type: result, loc,
  };
}

export function lowerBunWhichValue(L: Lowerer, expr: ts.Expression): IrExpr | null {
  if (!whichMember(L, expr)) return null;
  const loc: SrcLoc = locOf(expr), type = L.irTypeOf(expr);
  if (type.kind !== "func" || type.params.length !== 2 || type.params[0]?.kind !== "string" || !type.params[1]) L.noLowering("Bun.which function signature", expr);
  const key = `bun.which.value:${typeKey(type)}`;
  let name = L.widthHelpers.get(key);
  if (!name) {
    name = `%bun.which.value.${L.widthHelpers.size}`;
    const params = type.params.map((param, index) => ({ localId: `arg.${index}`, name: `arg${index}`, type: param }));
    const value = whichCall(L, varRef("arg.0", STRING, loc), varRef("arg.1", type.params[1], loc), type.ret, expr);
    L.liftedFns.push({ name, params, locals: params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })), returnType: type.ret, body: [{ kind: "return", value, loc }], loc });
    L.widthHelpers.set(key, name);
  }
  L.noteEdge(name);
  return { kind: "closure", fnName: name, captures: [], type, loc };
}
