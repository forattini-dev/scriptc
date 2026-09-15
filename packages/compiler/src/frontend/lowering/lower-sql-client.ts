/* effect/unstable/sql over the effect kernel (runtime-rust effect_sql.rs): the SqlClient service key, SqlClient.make
 * over the program's Connection record, statements and transactions, and the Reactivity layer the client requires.
 * Every entry answers null for anything that is not its surface, so lower-effect keeps trying its own rules. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { newFnCtx } from "./lowerer.js";
import { DYN, EFFECT_T, IrExpr, IrLibFn, IrLocal, IrStmt, IrType, STRING, SrcLoc } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { effectSuccessOf } from "./lower-effect.js";

function lib(fn: IrLibFn, args: IrExpr[], type: IrType, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn, args, type, loc };
}

/** `SqlClient.SqlClient` (also through an import alias): the service key "effect/sql/SqlClient", effect's own id. */
export function lowerSqlServiceKey(L: Lowerer, node: ts.Identifier | ts.PropertyAccessExpression): IrExpr | null {
  if (!distServiceConst(L, node, "sql/SqlClient", "SqlClient")) return null;
  const loc = locOf(node);
  return lib("effect.serviceKeyIdentity", ["effect/sql/SqlClient", "effect/sql/SqlClient"].map(value => ({ kind: "strLit", value, type: STRING, loc })), EFFECT_T, loc);
}

/** Whether `node` names the service const `name` that effect's `dist/unstable/<area>` module declares (e.g. `SqlClient`
 * from sql/SqlClient.d.ts, a `Context.Service` whose key is its module path). */
function distServiceConst(L: Lowerer, node: ts.Identifier | ts.PropertyAccessExpression, module: string, name: string): boolean {
  let symbol = L.checker.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.name);
  if (symbol === undefined) return false;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = L.checker.getAliasedSymbol(symbol);
  return symbol.name === name && L.checker.declarationsOf(symbol).some((declaration) =>
    ts.isVariableDeclaration(declaration) && declaration.getSourceFile().fileName.replace(/\\/g, "/").endsWith(`/node_modules/effect/dist/unstable/${module}.d.ts`));
}

/** Namespace VALUE reads: `SqlClient.SafeIntegers` and `Reactivity.layer`. */
export function lowerSqlNamespaceProperty(ns: string | null, name: string, loc: SrcLoc): IrExpr | null {
  if (ns === "sql/SqlClient" && name === "SafeIntegers") return lib("effect.sqlSafeIntegers", [], EFFECT_T, loc);
  // Reactivity (query invalidation) is not observable natively: its layer provides nothing.
  if (ns === "reactivity/Reactivity" && name === "layer") return lib("layer.empty", [], EFFECT_T, loc);
  return null;
}

/** Property reads on a native client or statement handle: `client.transactionService`, `client.reserve`, and a
 * statement's `withoutTransform` / `values` / `raw` / `unprepared` effects. */
export function lowerSqlHandleProperty(L: Lowerer, expr: ts.PropertyAccessExpression, loc: SrcLoc): IrExpr | null {
  const handleName = L.typeOf(expr.expression).getSymbol()?.name;
  if (handleName === "SqlClient" && (expr.name.text === "transactionService" || expr.name.text === "reserve")) {
    return lib(expr.name.text === "reserve" ? "effect.sqlReserve" : "effect.sqlTransactionKey", [L.lowerExpr(expr.expression)], EFFECT_T, loc);
  }
  if (handleName === "Statement" && ["withoutTransform", "values", "raw", "unprepared"].includes(expr.name.text)) {
    // Connection results travel as checked-dynamic rows; the statement's declared row type is checked on the way out.
    const run = lib("effect.sqlRun", [L.lowerExpr(expr.expression), { kind: "strLit", value: expr.name.text, type: STRING, loc }], EFFECT_T, loc);
    const success = effectSuccessOf(L, L.typeOf(expr));
    const target = success === null ? DYN : L.mapTypeOf(success);
    if (target === null) return L.unsupported("SC1090", expr, `SQL rows of type '${L.checker.typeToString(success!)}'`);
    return target.kind === "dyn" ? run : lib("effect.map", [run, liftedDynCheck(L, target, loc)], EFFECT_T, loc);
  }
  return null;
}

/** `client.unsafe(sql, params?)` / `client.withTransaction(effect)` on a native SqlClient handle. */
export function lowerSqlHandleCall(L: Lowerer, callee: ts.Expression, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  if (L.dynamic || !ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name) || callee.questionDotToken) return null;
  if (L.typeOf(callee.expression).getSymbol()?.name !== "SqlClient" || L.mapTypeOf(L.typeOf(callee.expression))?.kind !== "effect") return null;
  const client = L.lowerExpr(callee.expression);
  if (callee.name.text === "unsafe" && (expr.arguments.length === 1 || expr.arguments.length === 2)) {
    const sql = L.lowerExprExpecting(expr.arguments[0]!, STRING);
    const paramsNode = expr.arguments[1];
    const params: IrExpr = paramsNode === undefined ? { kind: "dynArrLit", elems: [], type: DYN, loc } : sqlDyn(L, L.lowerExprExpecting(paramsNode, DYN), paramsNode);
    return lib("effect.sqlUnsafe", [client, sql, params], EFFECT_T, loc);
  }
  if (callee.name.text === "withTransaction" && expr.arguments.length === 1) {
    const body = L.lowerExpr(expr.arguments[0]!);
    if (body.type.kind === "effect") return lib("effect.sqlWithTransaction", [client, body], EFFECT_T, loc);
  }
  return L.unsupported("SC1090", expr, `the effect kernel does not cover SqlClient.${callee.name.text} in this call shape yet`);
}

/** Namespace calls: `Statement.makeCompilerSqlite(...)` and `SqlClient.make({ … })`. */
export function lowerSqlNamespaceCall(L: Lowerer, ns: string, member: string, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  if (ns === "sql/Statement" && member === "makeCompilerSqlite" && expr.arguments.length <= 1) {
    const evaluated = expr.arguments.map((arg): IrStmt => ({ kind: "exprStmt", expr: L.lowerExpr(arg), loc }));
    const compiler = lib("effect.sqlCompiler", [], EFFECT_T, loc);
    return evaluated.length === 0 ? compiler : { kind: "seqExpr", stmts: evaluated, result: compiler, type: EFFECT_T, loc };
  }
  if (ns === "sql/SqlClient" && member === "make" && expr.arguments.length === 1 && ts.isObjectLiteralExpression(expr.arguments[0]!)) {
    return lowerSqlClientMake(L, expr.arguments[0], expr, loc);
  }
  return null;
}

/** A checked-dynamic value for a SQL parameter list. */
function sqlDyn(L: Lowerer, value: IrExpr, node: ts.Node): IrExpr {
  if (value.type.kind === "dyn") return value;
  if (L.dynConvertible(value.type)) return { kind: "dynFrom", value, type: DYN, loc: value.loc };
  return L.unsupported("SC1090", node, `SQL parameters of type '${L.fmt(value.type)}'`);
}

/** `SqlClient.make({ acquirer, transactionAcquirer?, compiler, spanAttributes })`: the native client over the program's
 * Connection record (named by the acquirer's success type). Row transforms are not honored yet. */
function lowerSqlClientMake(L: Lowerer, options: ts.ObjectLiteralExpression, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  let acquirer: { node: ts.Expression; value: IrExpr } | undefined;
  let transactionAcquirer: IrExpr | undefined;
  const evaluated: IrStmt[] = [];
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      return L.unsupported("SC1090", property, "SqlClient.make options that are not plain property assignments");
    }
    if (!ts.isIdentifier(property.name)) return L.unsupported("SC1090", property, "SqlClient.make options with computed keys");
    const node = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
    const name = property.name.text;
    if (name === "transformRows") {
      if (node.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isIdentifier(node) && node.text === "undefined")) {
        return L.unsupported("SC1090", property, "SqlClient.make row transforms (transformRows) are not supported yet");
      }
      continue;
    }
    const value = L.lowerExpr(node);
    if (name === "acquirer") acquirer = { node, value };
    else if (name === "transactionAcquirer") transactionAcquirer = value;
    else if (name === "compiler" || name === "spanAttributes") evaluated.push({ kind: "exprStmt", expr: value, loc });
    else return L.unsupported("SC1090", property, `the SqlClient.make option '${name}' is not supported yet`);
  }
  if (acquirer === undefined || acquirer.value.type.kind !== "effect") return L.unsupported("SC1090", expr, "SqlClient.make without an acquirer effect");
  if (transactionAcquirer !== undefined && transactionAcquirer.type.kind !== "effect") return L.unsupported("SC1090", expr, "SqlClient.make with a non-effect transactionAcquirer");
  const success = effectSuccessOf(L, L.typeOf(acquirer.node));
  const acquired = success === null ? null : L.mapTypeOf(success);
  if (acquired?.kind !== "record") {
    return L.unsupported("SC1090", acquirer.node, `SqlClient.make over a connection of type '${success === null ? "unknown" : L.checker.typeToString(success)}' (a Connection record is required)`);
  }
  // The transaction service's `readonly [conn: Connection, depth: number]` names effect's own Connection record: the
  // client runs every connection at that shape, so an acquired subtype (a SqliteConnection) narrows on acquisition.
  const client = effectSuccessOf(L, L.typeOf(expr));
  const serviceProp = client === null ? undefined : L.checker.getPropertyOfType(client, "transactionService");
  const serviceType = serviceProp === undefined ? null : L.checker.getTypeOfSymbol(serviceProp);
  const tupleTs = serviceType === null ? undefined : L.checker.getTypeArguments(serviceType as ts.TypeReference)[1];
  const tuple = tupleTs === undefined ? null : L.mapTypeOf(tupleTs);
  const tupleShape = tuple?.kind === "record" ? L.shapes.get(tuple.shapeId) : undefined;
  const connection = tupleShape?.tuple === true ? tupleShape.fields.find((field) => field.name === "0")?.type : undefined;
  const depth = tupleShape?.fields.find((field) => field.name === "1")?.type;
  if (tuple === null || tupleShape === undefined || connection?.kind !== "record" || depth?.kind !== "f64") {
    return L.unsupported("SC1090", expr, "SqlClient.make whose transaction service is not a [Connection, number] tuple");
  }
  const narrow = (source: IrExpr): IrExpr => acquired.shapeId === connection.shapeId ? source
    : lib("effect.map", [source, liftedSqlFn(L, [acquired], connection, ([value]) => L.coerceInto(acquirer.node, value!, connection), loc)], EFFECT_T, loc);
  const made = lib("effect.sqlClientMake", [
    narrow(acquirer.value),
    narrow(transactionAcquirer ?? acquirer.value),
    { kind: "strLit", value: `record:${connection.shapeId}`, type: STRING, loc },
    liftedSqlFn(L, [connection, depth], tuple, ([conn, level]) => ({ kind: "recordLit", fields: [{ name: "0", value: conn! }, { name: "1", value: level! }], type: tuple, loc }), loc),
    liftedSqlFn(L, [tuple], connection, ([entry]) => ({ kind: "recordGet", obj: entry!, shapeId: tupleShape.id, field: "0", type: connection, loc }), loc),
    liftedSqlFn(L, [tuple], depth, ([entry]) => ({ kind: "recordGet", obj: entry!, shapeId: tupleShape.id, field: "1", type: depth, loc }), loc),
  ], EFFECT_T, loc);
  return evaluated.length === 0 ? made : { kind: "seqExpr", stmts: evaluated, result: made, type: EFFECT_T, loc };
}

/** A capture-free lifted closure over `params` whose body returns `body(parameter refs)`. */
function liftedSqlFn(L: Lowerer, params: IrType[], ret: IrType, body: (refs: IrExpr[]) => IrExpr, loc: SrcLoc): IrExpr {
  const name = `%effect.sql.${L.liftedFns.length}`;
  L.fnStack.push(newFnCtx(false, null, null, ret));
  try {
    const locals: IrLocal[] = params.map((type, index) => ({ id: `p${index}.0`, name: `p${index}`, type, mutable: false }));
    L.ctx.locals.push(...locals);
    const refs: IrExpr[] = locals.map((local) => ({ kind: "varRef", localId: local.id, type: local.type, loc }));
    const result = body(refs);
    L.liftedFns.push({ name, params: locals.map((local) => ({ localId: local.id, name: local.name, type: local.type })), returnType: ret, locals: L.ctx.locals, body: [{ kind: "return", value: result, loc }], loc });
  } finally {
    L.fnStack.pop();
  }
  return { kind: "closure", fnName: name, captures: [], type: { kind: "func", params, ret }, loc };
}

/** The closure `(rows: unknown) => rows as T`, checked. */
function liftedDynCheck(L: Lowerer, target: IrType, loc: SrcLoc): IrExpr {
  const name = `%effect.sqlRows.${L.liftedFns.length}`;
  L.fnStack.push(newFnCtx(false, null, null, target));
  try {
    const local: IrLocal = { id: "rows.0", name: "rows", type: DYN, mutable: false };
    L.ctx.locals.push(local);
    const checked: IrExpr = { kind: "dynCheck", value: { kind: "varRef", localId: local.id, type: DYN, loc }, type: target, loc };
    L.liftedFns.push({ name, params: [{ localId: local.id, name: local.name, type: DYN }], returnType: target, locals: L.ctx.locals, body: [{ kind: "return", value: checked, loc }], loc });
  } finally {
    L.fnStack.pop();
  }
  return { kind: "closure", fnName: name, captures: [], type: { kind: "func", params: [DYN], ret: target }, loc };
}
