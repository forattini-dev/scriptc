/* Closure FAMILIES: a generic function VALUE — `tags.make("location")` returning a `<Impl, Items>(input) => Node`, a
 * service shape's `publish<T>(e: T)` — has no single signature to compile, so it lowers as a FAMILY: one
 * implementation per function node (with the enclosing frame's captures, boxed like any closure) and one native body
 * per instantiation the program's call sites DEMAND. The value is `Gc<sc_family_N>` (a variant per implementation over
 * its captures); a call at instantiation K dispatches on the variant to that implementation's body for K. Demands and
 * implementations arrive in any order: each new one instantiates against all of the other. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { newFnCtx, type FnCtx } from "./lowerer.js";
import { IrExpr, IrFamily, IrLocal, IrParam, IrType, SrcLoc, typeKey } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { familyIdOf } from "../families.js";
import { inferTypeParamBindings, internGenericInstance, type GenericFnInfo, type GenericInstance, type ParamShape } from "./lower-calls.js";

export interface FamilyDemand { key: string; params: ParamShape[]; ret: IrType; call: ts.CallExpression; rsig: ts.Signature }
export interface FamilyBuild { id: string; impls: GenericFnInfo[]; demands: Map<string, FamilyDemand> }
interface FamilyRegistry { builds: Map<string, FamilyBuild>; implsByNode: Map<ts.Node, Map<FnCtx | undefined, GenericFnInfo>>; counter: number }

/** The instantiation key of a demand — the same signature identity internGenericInstance keys its table on. */
function genericInstanceKey(params: ParamShape[], ret: IrType): string {
  return `${params.map((s) => typeKey(s.type)).join(",")}=>${typeKey(ret)}`;
}

const registries = new WeakMap<Lowerer, FamilyRegistry>();
function registry(L: Lowerer): FamilyRegistry {
  let r = registries.get(L);
  if (r === undefined) { r = { builds: new Map(), implsByNode: new Map(), counter: 0 }; registries.set(L, r); }
  return r;
}
/** A family the TYPE mapper minted: an inert declaration (`var f: <T>(x: T) => T` never read) still names a family,
 * and the module owes it a definition. */
export function noteFamily(L: Lowerer, id: string): void { buildOf(L, id); }

function buildOf(L: Lowerer, id: string): FamilyBuild {
  const r = registry(L);
  let build = r.builds.get(id);
  if (build === undefined) { build = { id, impls: [], demands: new Map() }; r.builds.set(id, build); }
  return build;
}

type FamilyFn = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

/** The function expression behind a value (parentheses and casts stripped), when it is one. */
export function familyFnNodeOf(node: ts.Expression): FamilyFn | null {
  let x: ts.Expression = node;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isTypeAssertion(x)) x = x.expression;
  return ts.isArrowFunction(x) || ts.isFunctionExpression(x) ? x : null;
}

/** An implementation joining a family: the function node lowers per demanded instantiation; its free locals become
 * the implementation's captures NOW (the enclosing frame is live — the closure rule boxes the origins). A node
 * without type parameters (a plain arrow cast to a generic type, effect's `as Tags<C>["make"]`) instantiates by the
 * demanded signature, its parameters retyped per instantiation. */
export function lowerFamilyImpl(L: Lowerer, node: FamilyFn, familyId: string | null, slotType?: ts.Type): IrExpr {
  const loc = locOf(node);
  const r = registry(L);
  const id = familyId ?? familyIdOf(L.checker, L.typeOf(node));
  if (id === null) L.unsupported("SC1090", node, "a generic function value whose signature has no family identity");
  // One AST node can occur in several specializations of its enclosing
  // generic function. Each frame owns different locals and capture types;
  // reusing another frame's implementation also skips boxing these locals.
  const owner = L.fnStack.at(-1);
  const existing = r.implsByNode.get(node)?.get(owner);
  if (existing !== undefined && existing.family !== undefined) {
    if (existing.family.id !== id) L.unsupported("SC1090", node, "one generic function value joining two families");
    return { kind: "familyClosure", familyId: id, impl: existing.qualifiedName, captures: existing.family.captureSources, type: { kind: "genericFunc", familyId: id }, loc };
  }
  if (node.asteriskToken !== undefined) L.unsupported("SC1071", node, "generator generic function values");
  if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) L.unsupported("SC1090", node, "async generic function values");
  if (ts.isMethodDeclaration(node) && node.body === undefined) L.unsupported("SC1090", node, "body-less generic methods");
  // Captures: every identifier of the body that resolves to a local of an ENCLOSING frame, threaded through a scratch
  // lifted context so resolveLocal records (and boxes) exactly what a closure would.
  const scratch = newFnCtx(true, null, null, { kind: "void" });
  const captureSymbols: ts.Symbol[] = [];
  const recorded = new Set<ts.Symbol>();
  const origins: IrLocal[] = [];
  L.fnStack.push(scratch);
  try {
    const inside = (d: ts.Node): boolean => d.getSourceFile() === node.getSourceFile() && d.pos >= node.pos && d.end <= node.end;
    const visit = (n: ts.Node): void => {
      if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
      if (ts.isIdentifier(n)) {
        const parent = n.parent;
        const isName = parent !== undefined && ((ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n) || (ts.isMethodDeclaration(parent) && parent.name === n) || ((ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === n) || ts.isTypeParameterDeclaration(parent) || ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent));
        if (!isName) {
          // A shorthand property name (`{ tag }`) declares a property symbol whose declaration sits INSIDE the body;
          // the binding it reads is the value symbol (resolveLocal's own rule).
          const sym = n.parent !== undefined && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
            ? (L.checker.getShorthandAssignmentValueSymbol(n.parent) ?? L.checker.getSymbolAtLocation(n))
            : L.checker.getSymbolAtLocation(n);
          const decl = sym === undefined ? undefined : L.checker.valueDeclarationOf(sym);
          if (sym !== undefined && !(decl !== undefined && inside(decl)) && !scratch.captureBySymbol.has(sym)) {
            // resolveLocal keys the capture by the BINDING's symbol, which is not always this identifier's symbol
            // (a shorthand property's name symbol is the property's) — read back whatever it recorded.
            L.resolveLocal(n);
            for (const [captured, entry] of scratch.captureBySymbol) {
              if (recorded.has(captured)) continue;
              recorded.add(captured);
              captureSymbols.push(captured);
              // The ORIGIN entry (the enclosing frame's local) carries mutability and TDZ for the instance's entries.
              for (let depth = L.fnStack.length - 2; depth >= 0; depth--) { const origin = L.bindingIn(L.fnStack[depth]!, captured); if (origin) { origins.push(origin); break; } }
              void entry;
            }
          }
        }
        return;
      }
      ts.forEachChild(n, visit);
    };
    for (const p of node.parameters) visit(p);
    if (node.body) visit(node.body);
  } finally {
    L.fnStack.pop();
  }
  if (origins.length !== captureSymbols.length) L.unsupported("SC1090", node, "a generic function value whose captures have no origin frame");
  // The instantiation's type parameters: the node's own when it declares them, otherwise the SLOT's (a plain arrow
  // cast into a generic signature borrows that signature's — `T` in the body's types is the interface's `T`).
  const own = (node.typeParameters ?? []).map((tp) => L.checker.getSymbolAtLocation(tp.name)).filter((s): s is ts.Symbol => s !== undefined);
  const cast = own.length === 0;
  let typeParams = own;
  if (cast) {
    const slot = slotType ?? L.checker.getContextualType(node as ts.Expression) ?? undefined;
    const slotSigs = slot === undefined ? [] : L.checker.getCallSignatures(slot);
    typeParams = (slotSigs.length === 1 ? (slotSigs[0]!.getTypeParameters() ?? []) : [])
      .map((tp) => tp.getSymbol()).filter((s): s is ts.Symbol => s !== undefined);
    if (typeParams.length === 0) L.unsupported("SC1090", node, "a generic function value whose type parameters do not resolve at its slot");
  }
  const index = r.counter++;
  const build = buildOf(L, id);
  const info: GenericFnInfo = {
    decl: node,
    baseName: ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : `family${index}`,
    qualifiedName: L.qualify(node.getSourceFile(), `%family.${index}`),
    typeParams,
    instances: new Map(),
    family: { id, captures: scratch.captures ?? [], captureSources: scratch.captureSources, captureSymbols, origins, cast },
  };
  let frameImpls = r.implsByNode.get(node);
  if (frameImpls === undefined) { frameImpls = new Map(); r.implsByNode.set(node, frameImpls); }
  frameImpls.set(owner, info);
  build.impls.push(info);
  for (const demand of build.demands.values()) familyInstance(L, info, demand);
  return { kind: "familyClosure", familyId: id, impl: info.qualifiedName, captures: info.family!.captureSources, type: { kind: "genericFunc", familyId: id }, loc };
}

/** A call through a family value: the resolved signature is the instantiation; every implementation gets a body. */
export function lowerFamilyCall(L: Lowerer, call: ts.CallExpression, callee: IrExpr): IrExpr {
  const loc = locOf(call);
  if (callee.type.kind !== "genericFunc") L.unsupported("SC1090", call, "a family call over a non-family value");
  const familyId = callee.type.familyId;
  const rsig = L.checker.getResolvedSignature(call);
  if (!rsig) L.unsupported("SC1090", call, "this call form");
  if (call.arguments.some((a) => ts.isSpreadElement(a))) L.unsupported("SC1090", call, "spread arguments to a generic function value");
  const params: ParamShape[] = rsig.getParameters().map((p) => {
    const decl = L.checker.valueDeclarationOf(p);
    if (decl !== undefined && ts.isParameter(decl) && decl.dotDotDotToken !== undefined) L.unsupported("SC1090", call, "rest parameters of a generic function value");
    const tsType = L.checker.getTypeOfSymbol(p);
    const type = L.mapTypeOf(tsType);
    if (type === null) L.badType(call, tsType);
    const optional = decl !== undefined && ts.isParameter(decl) && (decl.questionToken !== undefined || decl.initializer !== undefined);
    return { type, mode: optional ? "omittable" : "required" };
  });
  const retTs = L.checker.getReturnTypeOfSignature(rsig);
  const ret = L.mapTypeOf(retTs);
  if (ret === null) L.badType(call, retTs);
  const key = genericInstanceKey(params, ret);
  const build = buildOf(L, familyId);
  if (!build.demands.has(key)) {
    const demand: FamilyDemand = { key, params, ret, call, rsig };
    build.demands.set(key, demand);
    for (const impl of build.impls) familyInstance(L, impl, demand);
  }
  const args = L.completeArgs(call.arguments, params, loc, call);
  return { kind: "callFamily", callee, familyId, instKey: key, args, type: ret, loc };
}

/** One implementation's body for one demand: the type parameters (the node's own, or the slot signature's for a
 * cast implementation) unify against the demanded signature exactly as a generic call's do. */
function familyInstance(L: Lowerer, impl: GenericFnInfo, demand: FamilyDemand): GenericInstance {
  const tsBindings = new Map<ts.Symbol, ts.Type>();
  return internGenericInstance(L, demand.call, impl, demand.params, demand.ret,
    () => inferTypeParamBindings(L, demand.call, impl, demand.rsig, tsBindings), { tsBindings });
}

/** The instance context of a family body: its captures are the implementation's, pre-bound by symbol so the body's
 * references resolve to them (the enclosing frames are long gone by the time the instance lowers). */
export function prepareFamilyInstanceCtx(L: Lowerer, info: GenericFnInfo, ctx: FnCtx): void {
  const family = info.family!;
  family.captures.forEach((capture, i) => {
    const origin = family.origins[i]!;
    const entry: IrLocal = { id: capture.localId, name: capture.name, type: capture.type, mutable: origin.mutable, boxed: true, ...(origin.tdz ? { tdz: true as const } : {}) };
    ctx.locals.push(entry);
    ctx.captureBySymbol.set(family.captureSymbols[i]!, entry);
    ctx.captures!.push({ localId: entry.id, name: entry.name, type: entry.type });
    const dot = capture.localId.lastIndexOf(".");
    const counter = Number(capture.localId.slice(dot + 1));
    ctx.localCounters.set(capture.name, Math.max(ctx.localCounters.get(capture.name) ?? 0, counter + 1));
  });
  void L;
}

/** The module's families: implementations with their capture layouts, instantiations with a body per implementation. */
export function familiesIr(L: Lowerer): IrFamily[] {
  const out: IrFamily[] = [];
  for (const build of registry(L).builds.values()) {
    out.push({
      id: build.id,
      impls: build.impls.map((impl) => ({ name: impl.qualifiedName, captures: impl.family!.captures })),
      instances: [...build.demands.values()].map((demand) => ({
        key: demand.key,
        params: demand.params.map((p) => p.type),
        ret: demand.ret,
        targets: build.impls.map((impl) => {
          const inst = impl.instances.get(demand.key);
          if (inst === undefined) throw new Error(`scriptc: family '${build.id}' implementation '${impl.qualifiedName}' has no body for '${demand.key}'`);
          return inst.name;
        }),
      })),
    });
  }
  return out;
}

export type { IrParam, SrcLoc, typeKey as _typeKey };
