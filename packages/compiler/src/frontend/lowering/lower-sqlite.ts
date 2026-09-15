/* Static `bun:sqlite` under --target bun (Rust, runtime feature `sqlite`): the
 * `Database` class and its statements are native handles (the IR's sqliteDb /
 * sqliteStmt kinds) over the runtime's SQLite engine. Bindings cross as one
 * checked-dynamic argument pack (Bun's normalizeParams decides positional or
 * named at runtime), and results are checked back to the call's static type.
 * The island lane keeps its own facade; --dynamic builds never reach here. */
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { DYN, SQLITE_DB_T, SQLITE_STMT_T, STRING, UNDEFINED_T, VOID, type IrExpr, type IrLibFn, type IrType, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { packDynamicRest } from "./dynamic-rest.js";

/** A spread source under its type-only wrappers: `...(params as any)` spreads `params`. */
function unwrapTypeOnly(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** True for a class declared inside `declare module "bun:sqlite"` (bun-types or a local shim). */
function declaredInBunSqlite(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isModuleDeclaration(parent) && ts.isStringLiteral(parent.name)) return parent.name.text === "bun:sqlite";
  }
  return false;
}

function isBunSqliteClass(lowerer: Lowerer, symbol: ts.Symbol | null | undefined, name: string): boolean {
  if (!symbol) return false;
  let target = symbol;
  if ((target.flags & ts.SymbolFlags.Alias) !== 0) target = lowerer.checker.getAliasedSymbol(target);
  return target.name === name && lowerer.checker.declarationsOf(target).some((d) => ts.isClassDeclaration(d) && declaredInBunSqlite(d));
}

function asDyn(lowerer: Lowerer, value: IrExpr, node: ts.Node, what: string): IrExpr {
  if (value.type.kind === "dyn") return value;
  if (value.kind === "unitLit" || lowerer.dynConvertible(value.type)) return { kind: "dynFrom", value, type: DYN, loc: value.loc };
  return lowerer.noLowering(`bun:sqlite ${what} of type '${lowerer.fmt(value.type)}'`, node);
}

/** The binding pack: every argument as a dynamic element, spreads kept (their `as any` casts seen through). */
function lowerBindings(lowerer: Lowerer, args: readonly ts.Expression[], blame: ts.Node, loc: SrcLoc): IrExpr {
  // `...params` alone over a checked-dynamic array: that array IS the argument pack.
  if (args.length === 1 && ts.isSpreadElement(args[0]!)) {
    const source = lowerer.lowerExpr(unwrapTypeOnly(args[0].expression));
    if (source.type.kind === "dyn") return source;
  }
  // Otherwise the ordinary dynamic argument vector (each spread iterates at its own position).
  return packDynamicRest(lowerer, args, blame, loc);
}

function lib(fn: IrLibFn, args: IrExpr[], type: IrType, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn, args, type, loc };
}

/** A dynamic result checked back to the call's static type (unknown answers stay dynamic). */
function toCallType(lowerer: Lowerer, call: ts.CallExpression, value: IrExpr): IrExpr {
  // A result cast straight away (`stmt.values() as unknown[][]`, Redcode's idiom) checks into the cast's type.
  let node: ts.Node = call;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const target = node.parent !== undefined && ts.isAsExpression(node.parent) ? node.parent : call;
  const tsType = lowerer.typeOf(target);
  const type = lowerer.mapTypeOf(tsType);
  if (type === null) return lowerer.badType(call, tsType);
  return type.kind === "dyn" ? value : { kind: "dynCheck", value, type, loc: value.loc };
}

/** `new Database(filename?, options?)`. */
export function lowerSqliteDatabaseNew(lowerer: Lowerer, expr: ts.NewExpression, symbol: ts.Symbol | null): IrExpr | null {
  if (lowerer.dynamic || !isBunSqliteClass(lowerer, symbol, "Database")) return null;
  const loc = locOf(expr);
  const args = expr.arguments ?? [];
  if (args.length > 2 || args.some((arg) => ts.isSpreadElement(arg))) {
    lowerer.noLowering(`new Database with ${args.length} arguments`, expr, "a filename and an optional options object or flags number are the lowered forms");
  }
  const filename: IrExpr = args[0] === undefined
    ? { kind: "strLit", value: ":memory:", type: STRING, loc }
    : lowerer.lowerExprExpecting(args[0], STRING);
  const options: IrExpr = args[1] === undefined
    ? { kind: "dynFrom", value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, type: DYN, loc }
    : asDyn(lowerer, lowerer.lowerExprExpecting(args[1], DYN), args[1], "Database options");
  return lib("sqlite.open", [filename, options], SQLITE_DB_T, loc);
}

/** Database and Statement method calls on native handles. */
export function lowerSqliteMethodCall(lowerer: Lowerer, call: ts.CallExpression, access: ts.Expression): IrExpr | null {
  if (!ts.isPropertyAccessExpression(access) || call.questionDotToken || access.questionDotToken) return null;
  const receiverKind = lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind;
  if (receiverKind !== "sqliteDb" && receiverKind !== "sqliteStmt") return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  const receiver = (): IrExpr => lowerer.lowerExpr(access.expression);
  const sql = (): IrExpr => {
    if (args[0] === undefined || ts.isSpreadElement(args[0])) return lowerer.noLowering(`db.${name} without a SQL string`, call);
    return lowerer.lowerExprExpecting(args[0], STRING);
  };
  if (receiverKind === "sqliteDb") {
    switch (name) {
      case "run": case "exec": {
        const db = receiver();
        const text = sql();
        return toCallType(lowerer, call, lib("sqlite.dbRun", [db, text, lowerBindings(lowerer, args.slice(1), call, loc)], DYN, loc));
      }
      case "query": case "prepare": {
        if (args.length !== 1) lowerer.noLowering(`db.${name} with ${args.length} arguments`, call, "bind parameters when running the statement");
        const db = receiver();
        return lib(name === "query" ? "sqlite.query" : "sqlite.prepare", [db, sql()], SQLITE_STMT_T, loc);
      }
      case "close":
        if (args.length > 0) lowerer.noLowering("db.close with arguments", call);
        return lib("sqlite.close", [receiver()], VOID, loc);
      case "serialize":
        if (args.length > 0) lowerer.noLowering("db.serialize of an attached database name", call);
        return lib("sqlite.serialize", [receiver()], { kind: "bytes", elem: "u8" }, loc);
      case "loadExtension": {
        if (args.length !== 1) lowerer.noLowering(`db.loadExtension with ${args.length} arguments`, call);
        const db = receiver();
        return lib("sqlite.loadExtension", [db, lowerer.lowerExprExpecting(args[0]!, STRING)], VOID, loc);
      }
      default:
        return lowerer.noLowering(`Database.${name}`, call, "run, exec, query, prepare, close, serialize, and loadExtension are the lowered Database members");
    }
  }
  switch (name) {
    case "all": case "get": case "values": case "run": {
      const statement = receiver();
      const fn: IrLibFn = name === "all" ? "sqlite.all" : name === "get" ? "sqlite.get" : name === "values" ? "sqlite.values" : "sqlite.stmtRun";
      return toCallType(lowerer, call, lib(fn, [statement, lowerBindings(lowerer, args, call, loc)], DYN, loc));
    }
    // Not in bun-types (callers @ts-ignore it): Bun's per-statement bigint toggle.
    case "safeIntegers": {
      if (args.length !== 1 || ts.isSpreadElement(args[0]!)) lowerer.noLowering(`statement.safeIntegers with ${args.length} arguments`, call);
      const statement = receiver();
      const toggle = lowerer.lowerExpr(args[0]!);
      if (toggle.type.kind !== "bool") lowerer.noLowering(`statement.safeIntegers with a '${lowerer.fmt(toggle.type)}' toggle`, args[0]!);
      return lib("sqlite.safeIntegers", [statement, toggle], VOID, loc);
    }
    default:
      return lowerer.noLowering(`Statement.${name}`, call, "all, get, values, run, and safeIntegers are the lowered Statement members");
  }
}
