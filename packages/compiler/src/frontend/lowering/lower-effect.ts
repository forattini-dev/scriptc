/* The effect kernel's lowering (static builds): `import { Effect } from
 * "effect"` binds the package's namespace, and calls on it lower to the
 * native kernel (`effect.*` lib calls over runtime/effect.rs) instead of
 * embedding the package. Membership is by PROVENANCE — the binding's alias
 * target is the module namespace of effect/dist/<Ns>.d.ts — so a user
 * object named `Effect` never matches. A member the kernel does not cover
 * yet is a named refusal (the census in the plan file orders the work). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { EFFECT_T, IrExpr, IrLibFn, IrType, STRING, SrcLoc } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import { kernelServiceIdOfSymbol } from "../kernel.js";

const EFFECT_NAMESPACE_DTS = /[\\/]node_modules[\\/]effect[\\/]dist[\\/]([A-Za-z]+)\.d\.ts$/;

/** A named export of the effect package (`import { pipe } from "effect"`): the module it is declared in, by provenance. */
function effectExportOf(L: Lowerer, node: ts.Expression): { module: string; name: string } | null {
  if (L.dynamic || !ts.isIdentifier(node)) return null;
  let symbol = L.checker.getSymbolAtLocation(node);
  if (symbol === undefined) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = L.checker.getAliasedSymbol(symbol);
  for (const decl of L.checker.declarationsOf(symbol)) {
    const match = EFFECT_NAMESPACE_DTS.exec(decl.getSourceFile().fileName);
    if (match) return { module: match[1]!, name: symbol.name };
  }
  return null;
}

/** The effect namespace an expression names (`Effect`, `Layer`, …), or
 * null: only identifiers whose alias chain ends at effect/dist/<Ns>.d.ts. */
export function effectNamespaceOf(L: Lowerer, node: ts.Expression): string | null {
  if (L.dynamic || !ts.isIdentifier(node)) return null;
  let symbol = L.checker.getSymbolAtLocation(node);
  if (symbol === undefined) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = L.checker.getAliasedSymbol(symbol);
  for (const decl of L.checker.declarationsOf(symbol)) {
    if (!ts.isSourceFile(decl)) continue;
    const match = EFFECT_NAMESPACE_DTS.exec(decl.fileName);
    if (match) return match[1]!;
  }
  return null;
}

function lib(fn: IrLibFn, args: IrExpr[], type: IrType, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn, args, type, loc };
}

/** A reference to a kernel SERVICE KEY class (`Service`, `Config.Service` through a program namespace, an import alias):
 * the key value — an effect that looks the service up. Null for anything else. */
export function lowerServiceKeyRef(L: Lowerer, node: ts.Identifier | ts.PropertyAccessExpression): IrExpr | null {
  if (L.dynamic) return null;
  const id = kernelServiceIdOfSymbol(L.checker, L.checker.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.name));
  if (id === null) return null;
  const loc = locOf(node);
  return lib("effect.serviceKey", [{ kind: "strLit", value: id, type: STRING, loc }], EFFECT_T, loc);
}

/** `Effect.void`, `Layer.empty` and the other VALUE members of the namespaces (property reads), plus service key
 * classes read through a namespace; null for anything else (the property chain keeps trying). */
export function lowerEffectProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.name)) return null;
  const key = lowerServiceKeyRef(L, expr);
  if (key !== null) return key;
  const ns = effectNamespaceOf(L, expr.expression);
  const loc = locOf(expr);
  if (ns === "Effect" && expr.name.text === "void") return lib("effect.void", [], EFFECT_T, loc);
  if (ns === "Layer" && expr.name.text === "empty") return lib("layer.empty", [], EFFECT_T, loc);
  return null;
}

/** `Effect.fn("name")(function* (a, b) { … })`, `Effect.fn(function* …)`, `Effect.fnUntraced(…)`: a function whose
 * calls answer the generator body as an effect. The tracing name is not observable natively. */
function lowerEffectFn(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const callee = expr.expression;
  const isFnMember = (node: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && (node.name.text === "fn" || node.name.text === "fnUntraced") && effectNamespaceOf(L, node.expression) === "Effect";
  const named = ts.isCallExpression(callee) && isFnMember(callee.expression) && callee.arguments.length <= 1 && (callee.arguments.length === 0 || ts.isStringLiteral(callee.arguments[0]!));
  if (!named && !isFnMember(callee)) return null;
  const body = expr.arguments[0];
  if (expr.arguments.length !== 1 || body === undefined || !ts.isFunctionExpression(body) || body.asteriskToken === undefined) {
    L.unsupported("SC1090", expr, "the effect kernel covers Effect.fn over one generator function (no pipeline arguments yet)");
  }
  const lowered = L.lowerExpr(body);
  if (lowered.type.kind !== "func" || lowered.type.ret.kind !== "generator" || lowered.type.ret.yieldT.kind !== "effect") {
    L.unsupported("SC1090", expr, "the effect kernel covers Effect.fn over a generator body yielding effects");
  }
  return lib("effect.fn", [lowered], { kind: "func", params: lowered.type.params, ret: EFFECT_T }, loc);
}

/** One data-last combinator applied to an accumulated effect (`.pipe(Effect.map(f))`, `pipe(e, Effect.orDie)`): the
 * combinator call with the effect prepended lowers through the data-first table. */
function applyPipeStep(L: Lowerer, source: IrExpr, step: ts.Expression, loc: SrcLoc): IrExpr {
  if (ts.isPropertyAccessExpression(step) && ts.isIdentifier(step.name) && effectNamespaceOf(L, step.expression) === "Effect") {
    const bare: Record<string, IrLibFn | undefined> = { asVoid: "effect.asVoid", ignore: "effect.ignore", orDie: "effect.orDie" };
    const fn = bare[step.name.text];
    if (fn !== undefined) return lib(fn, [source], EFFECT_T, loc);
    L.unsupported("SC1090", step, `the effect kernel does not cover Effect.${step.name.text} as a pipe step yet`);
  }
  if (ts.isCallExpression(step) && ts.isPropertyAccessExpression(step.expression) && ts.isIdentifier(step.expression.name)) {
    const stepNs = effectNamespaceOf(L, step.expression.expression);
    if (stepNs === "Effect") return lowerEffectMember(L, step.expression.name.text, [source], [...step.arguments], step, loc);
    if (stepNs === "Layer") return lowerLayerMember(L, step.expression.name.text, [source], [...step.arguments], step, loc);
  }
  return L.unsupported("SC1090", step, "the effect kernel covers pipe steps that are Effect.* combinators");
}

/** `Effect.member(...)` → the kernel's lib call, or null when the callee
 * is not an effect namespace member (the call chain keeps trying). */
export function lowerEffectCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const callee = expr.expression;
  const asFn = lowerEffectFn(L, expr, loc);
  if (asFn !== null) return asFn;
  // `pipe(effect, step, …)` (effect's Function.pipe) and `effect.pipe(step, …)` fold the steps left to right.
  const free = effectExportOf(L, callee);
  if (free !== null && free.module === "Function" && free.name === "pipe" && expr.arguments.length >= 1) {
    let acc = L.lowerExpr(expr.arguments[0]!);
    if (acc.type.kind !== "effect") L.unsupported("SC1090", expr, "the effect kernel covers pipe over an Effect value");
    for (const step of expr.arguments.slice(1)) acc = applyPipeStep(L, acc, step, loc);
    return acc;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) && callee.name.text === "pipe" && !callee.questionDotToken && L.mapTypeOf(L.typeOf(callee.expression))?.kind === "effect") {
    let acc = L.lowerExpr(callee.expression);
    for (const step of expr.arguments) acc = applyPipeStep(L, acc, step, loc);
    return acc;
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null;
  const ns = effectNamespaceOf(L, callee.expression);
  if (ns === null) return null;
  if (ns === "Layer") return lowerLayerMember(L, callee.name.text, [], [...expr.arguments], expr, loc);
  if (ns !== "Effect") L.unsupported("SC1090", expr, `the effect kernel does not cover ${ns}.${callee.name.text} yet`);
  return lowerEffectMember(L, callee.name.text, [], [...expr.arguments], expr, loc);
}

/** One `Layer.member` call, the same shape as lowerEffectMember. Layers are kernel handles like effects. */
function lowerLayerMember(L: Lowerer, member: string, pre: IrExpr[], args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const total = pre.length + args.length;
  const lowered = new Map<number, IrExpr>();
  const at = (index: number): IrExpr => {
    const hit = lowered.get(index);
    if (hit !== undefined) return hit;
    const value = index < pre.length ? pre[index]! : L.lowerExpr(args[index - pre.length]!);
    lowered.set(index, value);
    return value;
  };
  const handles = (count: number): boolean => total === count && Array.from({ length: count }, (_, i) => at(i).type.kind === "effect").every(Boolean);
  switch (member) {
    case "succeed":
      if (total === 2 && at(0).type.kind === "effect") return lib("layer.succeed", [at(0), at(1)], EFFECT_T, loc);
      break;
    case "effect":
      if (handles(2)) return lib("layer.effect", [at(0), at(1)], EFFECT_T, loc);
      break;
    case "provide":
    case "provideMerge":
    case "merge":
      if (handles(2)) return lib(member === "provide" ? "layer.provide" : member === "provideMerge" ? "layer.provideMerge" : "layer.merge", [at(0), at(1)], EFFECT_T, loc);
      break;
    case "mergeAll": {
      if (total === 0) break;
      let acc = at(0);
      if (acc.type.kind !== "effect") break;
      for (let i = 1; i < total; i++) {
        const next = at(i);
        if (next.type.kind !== "effect") return L.unsupported("SC1090", expr, "Layer.mergeAll over non-layer arguments");
        acc = lib("layer.merge", [acc, next], EFFECT_T, loc);
      }
      return acc;
    }
    default:
      break;
  }
  return L.unsupported("SC1090", expr, `the effect kernel does not cover Layer.${member} in this call shape yet`);
}

/** One `Effect.member` call: `pre` are already-lowered leading arguments (a pipe's accumulated effect), `args` the
 * call's own. Unknown members and shapes are named refusals. */
function lowerEffectMember(L: Lowerer, member: string, pre: IrExpr[], args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const total = pre.length + args.length;
  const lowered = new Map<number, IrExpr>();
  const at = (index: number): IrExpr => {
    const hit = lowered.get(index);
    if (hit !== undefined) return hit;
    const value = index < pre.length ? pre[index]! : L.lowerExpr(args[index - pre.length]!);
    lowered.set(index, value);
    return value;
  };
  {
    switch (member) {
      case "succeed":
        if (total === 1) return lib("effect.succeed", [at(0)], EFFECT_T, loc);
        break;
      case "sync": {
        if (total !== 1) break;
        const thunk = at(0);
        if (thunk.type.kind === "func" && thunk.type.params.length === 0) return lib("effect.sync", [thunk], EFFECT_T, loc);
        break;
      }
      case "map":
      case "flatMap": {
        if (total !== 2) break;
        const source = at(0);
        const fn = at(1);
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length !== 1) break;
        if (member === "flatMap" && fn.type.ret.kind !== "effect") break;
        return lib(member === "map" ? "effect.map" : "effect.flatMap", [source, fn], EFFECT_T, loc);
      }
      case "gen": {
        if (total !== 1) break;
        const body = at(0);
        if (body.type.kind !== "func" || body.type.params.length !== 0 || body.type.ret.kind !== "generator" || body.type.ret.yieldT.kind !== "effect") break;
        return lib("effect.gen", [body], EFFECT_T, loc);
      }
      case "fail":
      case "die":
        if (total === 1) return lib(member === "fail" ? "effect.fail" : "effect.die", [at(0)], EFFECT_T, loc);
        break;
      case "catch": // effect 4's name for catchAll (v3's spelling is kept for programs written against it)
      case "catchAll":
      case "mapError": {
        if (total !== 2) break;
        const source = at(0);
        const fn = at(1);
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length !== 1) break;
        if (member !== "mapError" && fn.type.ret.kind !== "effect") break;
        return lib(member === "mapError" ? "effect.mapError" : "effect.catchAll", [source, fn], EFFECT_T, loc);
      }
      case "promise": {
        if (total !== 1) break;
        const thunk = at(0);
        if (thunk.type.kind !== "func" || thunk.type.params.length !== 0 || thunk.type.ret.kind !== "promise") break;
        return lib("effect.promise", [thunk], EFFECT_T, loc);
      }
      case "tryPromise": {
        // `Effect.tryPromise({ try: () => promise, catch: (reason) => error })` — the two callbacks lower separately; the
        // rejection reason reaches `catch` as the program's dynamic value (its type is `unknown`).
        const options = args[0];
        if (pre.length !== 0 || total !== 1 || options === undefined || !ts.isObjectLiteralExpression(options)) break;
        const property = (name: string): ts.Expression | null => {
          const found = options.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
          return found !== undefined && ts.isPropertyAssignment(found) ? found.initializer : null;
        };
        const tryNode = property("try");
        const catchNode = property("catch");
        if (tryNode === null || catchNode === null || options.properties.length !== 2) break;
        const attempt = L.lowerExpr(tryNode);
        const recover = L.lowerExpr(catchNode);
        if (attempt.type.kind !== "func" || attempt.type.params.length !== 0 || attempt.type.ret.kind !== "promise") break;
        if (recover.type.kind !== "func" || recover.type.params.length !== 1 || recover.type.params[0]!.kind !== "dyn") break;
        return lib("effect.tryPromise", [attempt, recover], EFFECT_T, loc);
      }
      case "orDie": {
        if (total !== 1) break;
        const source = at(0);
        if (source.type.kind !== "effect") break;
        return lib("effect.orDie", [source], EFFECT_T, loc);
      }
      case "as":
        if (total === 2 && at(0).type.kind === "effect") return lib("effect.as", [at(0), at(1)], EFFECT_T, loc);
        break;
      case "asVoid":
      case "ignore":
        if (total === 1 && at(0).type.kind === "effect") return lib(member === "asVoid" ? "effect.asVoid" : "effect.ignore", [at(0)], EFFECT_T, loc);
        break;
      case "andThen": {
        // `andThen(e, x)`: x an effect (run after), a thunk/function answering an effect (flatMap) or a value (map).
        if (total !== 2) break;
        const source = at(0);
        const next = at(1);
        if (source.type.kind !== "effect") break;
        if (next.type.kind === "effect") return lib("effect.andThenEffect", [source, next], EFFECT_T, loc);
        if (next.type.kind !== "func" || next.type.params.length > 1) break;
        return lib(next.type.ret.kind === "effect" ? "effect.flatMap" : "effect.map", [source, next], EFFECT_T, loc);
      }
      case "provide":
        if (total === 2 && at(0).type.kind === "effect" && at(1).type.kind === "effect") return lib("effect.provide", [at(0), at(1)], EFFECT_T, loc);
        break;
      case "provideService":
        if (total === 3 && at(0).type.kind === "effect" && at(1).type.kind === "effect") return lib("effect.provideService", [at(0), at(1), at(2)], EFFECT_T, loc);
        break;
      case "service":
        if (total === 1 && at(0).type.kind === "effect") return at(0); // a key IS the effect that looks the service up
        break;
      case "runSync":
      case "runPromise": {
        if (total !== 1) break;
        const source = at(0);
        const result = L.mapTypeOf(L.typeOf(expr));
        if (source.type.kind !== "effect" || result === null) break;
        if (member === "runPromise" && result.kind !== "promise") break;
        return lib(member === "runSync" ? "effect.runSync" : "effect.runPromise", [source], result, loc);
      }
      default:
        break;
    }
  }
  return L.unsupported("SC1090", expr, `the effect kernel does not cover Effect.${member} in this call shape yet`);
}
