import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { BOOL, DYN, JSVAL, STRING, VOID, canMarshalTypedFuncIntoIsland, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { type Lowerer, newFnCtx } from "./lowerer.js";
import { nativeImportTargetOf } from "./lower-native-import-types.js";
import { nativeModuleExports } from "./lower-native-import-exports.js";
import { nativeRecordShapeSupported } from "../../ir/native-record.js";

/** Local ESM imports own a cached evaluation and a live, singleton namespace.
 * JSVAL is the Rust runtime's safe handle here; no embedded engine is used. */
export function lowerNativeImportCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (L.dynamic) return null;
  const dep = nativeImportTargetOf(L, call);
  if (!dep) return null;
  const loc = locOf(call);
  const name = nativeNamespaceBuilder(L, dep, call);
  L.noteEdge(name);
  const result: IrType = { kind: "promise", inner: JSVAL };
  return {
    kind: "libCall", fn: "module.import", type: result, loc,
    args: [{ kind: "closure", fnName: name, captures: [], type: { kind: "func", params: [], ret: result }, loc }],
  };
}

function nativeNamespaceBuilder(L: Lowerer, dep: ts.SourceFile, site: ts.CallExpression): string {
  const cached = L.dynNsBuilders.get(dep);
  if (cached) return cached;
  const loc = locOf(site);
  const initName = L.initNameOf.get(dep)!;
  const tag = (L.fileTag.get(dep) || "e.").replace(/^%/, "");
  const name = `%native.ns.${tag}`;
  const namespaceId = `%g.${tag}%namespace`;
  const readyId = `%g.${tag}%namespaceReady`;
  L.globalsList.push(
    { id: namespaceId, name: "%namespace", type: JSVAL, mutable: true },
    { id: readyId, name: "%namespaceReady", type: BOOL, mutable: true },
  );
  const ctx = newFnCtx(true, null, null, JSVAL);
  ctx.isAsync = true;
  L.fnStack.push(ctx);
  try {
    const isAsync = L.asyncInitFiles.has(dep);
    const init: IrExpr = { kind: "call", callee: initName, args: [], type: isAsync ? { kind: "promise", inner: VOID } : VOID, loc };
    L.noteEdge(initName);
    const body: IrStmt[] = [];
    const cyclePromise = L.asyncCyclePromiseOf.get(dep);
    if (isAsync && cyclePromise) {
      body.push({ kind: "exprStmt", expr: init, loc });
      body.push({ kind: "exprStmt", expr: { kind: "awaitExpr", value: { kind: "varRef", localId: cyclePromise, type: { kind: "promise", inner: VOID }, loc }, type: VOID, loc }, loc });
    } else {
      body.push({ kind: "exprStmt", expr: isAsync ? { kind: "awaitExpr", value: init, type: VOID, loc } : init, loc });
    }
    const ref: IrExpr = { kind: "varRef", localId: namespaceId, type: JSVAL, loc };
    // Check after evaluation, including its await: simultaneous imports must
    // share the first completed namespace construction.
    body.push({ kind: "if", cond: { kind: "varRef", localId: readyId, type: BOOL, loc }, then: [{ kind: "return", value: ref, loc }], else_: null, loc });
    const object = L.declareHiddenLocal("%namespace", JSVAL);
    const objectRef: IrExpr = { kind: "varRef", localId: object.id, type: JSVAL, loc };
    body.push({ kind: "varDecl", localId: object.id, init: { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc }, loc });
    const entries = nativeModuleExports(L, dep, site);
    for (const [exportName, symbol] of entries) {
      const value = nativeExportValue(L, exportName, symbol, site, body);
      if (!value) continue;
      const getterName = `${name}.get.${exportName}`;
      L.liftedFns.push({ name: getterName, params: [], returnType: JSVAL, locals: [], captures: [], body: [{ kind: "return", value, loc }], loc });
      L.noteEdge(getterName);
      const getter: IrExpr = { kind: "jsMarshal", value: { kind: "closure", fnName: getterName, captures: [], type: { kind: "func", params: [], ret: JSVAL }, loc }, type: JSVAL, loc };
      const key: IrExpr = { kind: "jsMarshal", value: { kind: "strLit", value: exportName, type: STRING, loc }, type: JSVAL, loc };
      body.push({ kind: "exprStmt", expr: { kind: "jsOp", op: "defineGetter", args: [objectRef, key, getter], type: JSVAL, loc }, loc });
    }
    body.push(
      { kind: "assign", localId: namespaceId, value: { kind: "libCall", fn: "module.namespace", args: [objectRef], type: JSVAL, loc }, loc },
      { kind: "assign", localId: readyId, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
      { kind: "return", value: ref, loc },
    );
    L.liftedFns.push({ name, params: [], returnType: JSVAL, locals: ctx.locals, captures: [], body, async: true, loc });
    L.dynNsBuilders.set(dep, name);
    return name;
  } finally {
    L.fnStack.pop();
  }
}

function identitySafe(L: Lowerer, type: IrType): boolean {
  if (type.kind === "union") return L.unions.get(type.unionId)?.arms.every(arm => arm.kind !== "record" && identitySafe(L, arm)) ?? false;
  if (type.kind === "record") {
    const shape = L.shapes.get(type.shapeId);
    return !!shape && nativeRecordShapeSupported(shape, L.unions, id => L.shapes.get(id));
  }
  return ["f64", "bool", "string", "nullT", "undefinedT", "void", "jsval", "dyn"].includes(type.kind);
}

function callableHook(L: Lowerer, name: string, type: IrType): boolean {
  if (!["then", "toJSON", "toString", "valueOf"].includes(name)) return false;
  if (type.kind === "union") return L.unions.get(type.unionId)?.arms.some(arm => callableHook(L, name, arm)) ?? false;
  return ["func", "jsval", "dyn"].includes(type.kind);
}

function nativeExportValue(L: Lowerer, name: string, symbol: ts.Symbol, site: ts.CallExpression, setup: IrStmt[]): IrExpr | null {
  const loc = locOf(site);
  for (const decl of L.checker.declarationsOf(symbol)) {
    if (ts.isExportSpecifier(decl) && (decl.isTypeOnly || (ts.isExportDeclaration(decl.parent.parent) && decl.parent.parent.isTypeOnly))) return null;
  }
  // An entity-name default export owns snapshot storage under its alias.
  // Re-export chains must stop at that storage before ordinary alias chasing.
  const resolved = L.globalsBySymbol.has(symbol) ? symbol : L.defaultSnapshotSymbolOf(symbol) ??
    (symbol.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(symbol) : symbol);
  if (!(resolved.flags & ts.SymbolFlags.Value) && !L.globalsBySymbol.has(resolved)) return null;
  const refuse = (detail: string): never => L.unsupported("SC1090", site,
    `native import() export '${name}' ${detail}`);
  const marshal = (value: IrExpr): IrExpr => value.type.kind === "jsval" ? value : {
    kind: "jsMarshal", type: JSVAL, loc,
    value: value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc },
  };
  const global = L.globalsBySymbol.get(resolved);
  if (global) {
    if (!identitySafe(L, global.type)) refuse(`has type '${L.fmt(global.type)}'; preserving this export's identity requires a native reference view`);
    if (callableHook(L, name, global.type)) refuse("may be a callable namespace coercion/thenable hook and needs a native implementation");
    return marshal({ kind: "varRef", localId: global.id, type: global.type, loc });
  }
  const sig = L.fnSigsBySymbol.get(resolved);
  if (sig) {
    if (["then", "toJSON", "toString", "valueOf"].includes(name)) refuse("is a callable namespace coercion/thenable hook and needs a native implementation");
    // Promise handles retain the source identity and rejection; their
    // fulfillment mapper must still avoid copying composite values.
    const resultSafe = sig.returnType.kind === "promise"
      ? identitySafe(L, sig.returnType.inner)
      : identitySafe(L, sig.returnType);
    if (!sig.params.every(p => p.mode === "required" && identitySafe(L, p.type)) || !resultSafe) {
      refuse("has a function signature whose argument or result identity requires a native reference view");
    }
    L.noteEdge(sig.name);
    const declaration = L.checker.declarationsOf(resolved).find(ts.isFunctionDeclaration);
    const closure: IrExpr = { kind: "closure", fnName: sig.name, captures: [], type: { kind: "func", params: sig.params.map(p => p.type), ret: sig.returnType }, loc };
    if (closure.type.kind !== "func" || !canMarshalTypedFuncIntoIsland(closure.type, id => L.shapes.get(id), id => L.unions.get(id))) refuse("has a function signature outside native callback admission");
    // The dynamic wrapper owns function properties too. Re-marshaling the
    // same closure on each getter would lose those properties, even if its
    // underlying closure identity compared equal. Re-exports share this slot.
    let cache = L.nativeExportFunctions.get(sig.name);
    if (!cache) {
      cache = { valueId: `%g.nativeExport.${sig.name}`, readyId: `%g.nativeExportReady.${sig.name}` };
      L.nativeExportFunctions.set(sig.name, cache);
      L.globalsList.push(
        { id: cache.valueId, name: "%nativeExport", type: JSVAL, mutable: true },
        { id: cache.readyId, name: "%nativeExportReady", type: BOOL, mutable: true },
      );
    }
    setup.push({
      kind: "if", cond: { kind: "varRef", localId: cache.readyId, type: BOOL, loc }, then: [],
      else_: [
        { kind: "assign", localId: cache.valueId, value: marshal({ kind: "dynFrom", value: closure, fnName: declaration?.name?.text ?? "default", type: DYN, loc }), loc },
        { kind: "assign", localId: cache.readyId, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
      ], loc,
    });
    return { kind: "varRef", localId: cache.valueId, type: JSVAL, loc };
  }
  return refuse("has no identity-preserving native namespace representation");
}
