/* The effect kernel's lowering (static builds): `import { Effect } from
 * "effect"` binds the package's namespace, and calls on it lower to the
 * native kernel (`effect.*` lib calls over runtime/effect.rs) instead of
 * embedding the package. Membership is by PROVENANCE — the binding's alias
 * target is the module namespace of effect/dist/<Ns>.d.ts — so a user
 * object named `Effect` never matches. A member the kernel does not cover
 * yet is a named refusal (the census in the plan file orders the work). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { EFFECT_T, IrExpr, IrLibFn, IrType, SrcLoc } from "../../ir/nodes.js";

const EFFECT_NAMESPACE_DTS = /[\\/]node_modules[\\/]effect[\\/]dist[\\/]([A-Za-z]+)\.d\.ts$/;

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

/** `Effect.member(...)` → the kernel's lib call, or null when the callee
 * is not an effect namespace member (the call chain keeps trying). */
export function lowerEffectCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null;
  const ns = effectNamespaceOf(L, callee.expression);
  if (ns === null) return null;
  const member = callee.name.text;
  const args = expr.arguments;
  if (ns === "Effect") {
    switch (member) {
      case "succeed":
        if (args.length === 1) return lib("effect.succeed", [L.lowerExpr(args[0]!)], EFFECT_T, loc);
        break;
      case "sync": {
        if (args.length !== 1) break;
        const thunk = L.lowerExpr(args[0]!);
        if (thunk.type.kind === "func" && thunk.type.params.length === 0) return lib("effect.sync", [thunk], EFFECT_T, loc);
        break;
      }
      case "map":
      case "flatMap": {
        if (args.length !== 2) break;
        const source = L.lowerExpr(args[0]!);
        const fn = L.lowerExpr(args[1]!);
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length !== 1) break;
        if (member === "flatMap" && fn.type.ret.kind !== "effect") break;
        return lib(member === "map" ? "effect.map" : "effect.flatMap", [source, fn], EFFECT_T, loc);
      }
      case "gen": {
        if (args.length !== 1) break;
        const body = L.lowerExpr(args[0]!);
        if (body.type.kind !== "func" || body.type.params.length !== 0 || body.type.ret.kind !== "generator" || body.type.ret.yieldT.kind !== "effect") break;
        return lib("effect.gen", [body], EFFECT_T, loc);
      }
      case "fail":
      case "die":
        if (args.length === 1) return lib(member === "fail" ? "effect.fail" : "effect.die", [L.lowerExpr(args[0]!)], EFFECT_T, loc);
        break;
      case "catch": // effect 4's name for catchAll (v3's spelling is kept for programs written against it)
      case "catchAll":
      case "mapError": {
        if (args.length !== 2) break;
        const source = L.lowerExpr(args[0]!);
        const fn = L.lowerExpr(args[1]!);
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length !== 1) break;
        if (member !== "mapError" && fn.type.ret.kind !== "effect") break;
        return lib(member === "mapError" ? "effect.mapError" : "effect.catchAll", [source, fn], EFFECT_T, loc);
      }
      case "orDie": {
        if (args.length !== 1) break;
        const source = L.lowerExpr(args[0]!);
        if (source.type.kind !== "effect") break;
        return lib("effect.orDie", [source], EFFECT_T, loc);
      }
      case "runSync":
      case "runPromise": {
        if (args.length !== 1) break;
        const source = L.lowerExpr(args[0]!);
        const result = L.mapTypeOf(L.typeOf(expr));
        if (source.type.kind !== "effect" || result === null) break;
        if (member === "runPromise" && result.kind !== "promise") break;
        return lib(member === "runSync" ? "effect.runSync" : "effect.runPromise", [source], result, loc);
      }
      default:
        break;
    }
  }
  L.unsupported("SC1090", expr, `the effect kernel does not cover ${ns}.${member} in this call shape yet`);
}
