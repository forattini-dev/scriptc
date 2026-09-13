/* The effect kernel's lowering (static builds): `import { Effect } from
 * "effect"` binds the package's namespace, and calls on it lower to the
 * native kernel (`effect.*` lib calls over runtime/effect.rs) instead of
 * embedding the package. Membership is by PROVENANCE — the binding's alias
 * target is the module namespace of effect/dist/<Ns>.d.ts — so a user
 * object named `Effect` never matches. A member the kernel does not cover
 * yet is a named refusal (the census in the plan file orders the work). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js"; import { numLit } from "../../ir/build.js";
import { BOOL, DYN, EFFECT_T, IrExpr, canConvertToDyn, IrLibFn, IrLocal, IrType, STRING, SrcLoc, arrayOf, isSupportedArrayElem } from "../../ir/ir.js"; import { newFnCtx } from "./lowerer.js";
import { locOf } from "../program.js";
import { kernelServiceIdOfSymbol } from "../kernel.js";
import { applyProgramPipeStep, applySchemaPipeStep, isSchemaLike, lowerSchemaClassMake, lowerSchemaHandleMethod, lowerSchemaMember, lowerSchemaProperty, lowerSchemaTest, unwrapSchema } from "./lower-schema.js";
import { lowerConsoleInspectArg } from "./lower-inspect.js";

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
  if (ns === "Schema") return lowerSchemaProperty(L, expr, loc);
  if (ns === "Duration" && expr.name.text === "zero") return lib("effect.durationMillis", [numLit(0, loc)], EFFECT_T, loc);
  // Kernel DATA handles (an Exit): `_tag` and the success `value` read through the kernel, typed by the checker.
  if (ns === null && !expr.questionDotToken && L.mapTypeOf(L.typeOf(expr.expression))?.kind === "effect") {
    if (expr.name.text === "_tag") return lib("effect.dataTag", [L.lowerExpr(expr.expression)], STRING, loc);
    if (expr.name.text === "message") return lib("effect.dataMessage", [L.lowerExpr(expr.expression)], STRING, loc);
    if (expr.name.text === "value") {
      const valueT = L.mapTypeOf(L.typeOf(expr));
      if (valueT !== null) return lib("effect.exitValue", [L.lowerExpr(expr.expression)], valueT, loc);
    }
  }
  return null;
}

/** `Duration.member(...)`: a handle holding milliseconds — constructors by unit, `toMillis`/`toSeconds`. */
function lowerDurationMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const units: Record<string, number | undefined> = { nanos: 1e-6, micros: 1e-3, millis: 1, seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };
  const first = args[0];
  const unit = units[member];
  if (unit !== undefined && first !== undefined && args.length === 1) {
    const value = L.lowerExprExpecting(first, { kind: "f64" });
    const millis: IrExpr = unit === 1 ? value : { kind: "bin", op: "*", left: value, right: numLit(unit, loc), type: { kind: "f64" }, loc };
    return lib("effect.durationMillis", [millis], EFFECT_T, loc);
  }
  if ((member === "toMillis" || member === "toSeconds") && first !== undefined && args.length === 1) {
    const handle = L.lowerExpr(first);
    if (handle.type.kind !== "effect") L.unsupported("SC1090", first, `Duration.${member} over a non-Duration value`);
    const millis = lib("effect.durationToMillis", [handle], { kind: "f64" }, loc);
    return member === "toMillis" ? millis : { kind: "bin", op: "/", left: millis, right: numLit(1000, loc), type: { kind: "f64" }, loc };
  }
  return L.unsupported("SC1090", expr, `the effect kernel does not cover Duration.${member} in this call shape yet`);
}

/** `Exit.member(...)`: the opaque exit handle's constructors and tests. */
function lowerExitMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const first = args[0];
  if (first !== undefined && args.length === 1) {
    if (member === "succeed") return lib("effect.exitSucceed", [L.lowerExpr(first)], EFFECT_T, loc);
    if (member === "fail") return lib("effect.exitFail", [L.lowerExpr(first)], EFFECT_T, loc);
    if (member === "isSuccess" || member === "isFailure") {
      const exit = L.lowerExpr(first);
      if (exit.type.kind === "effect") return lib(member === "isSuccess" ? "effect.exitIsSuccess" : "effect.exitIsFailure", [exit], BOOL, loc);
    }
  }
  return L.unsupported("SC1090", expr, `the effect kernel does not cover Exit.${member} in this call shape yet`);
}

/** `Option.member(...)`: the opaque option handle's constructors, tests and reads (site-typed by the checker). */
function lowerOptionMember(L: Lowerer, member: string, pre: IrExpr[], args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const total = pre.length + args.length;
  const at = (index: number): IrExpr => index < pre.length ? pre[index]! : L.lowerExpr(args[index - pre.length]!);
  const result = (): IrType => L.mapTypeOf(L.typeOf(expr)) ?? L.badType(expr, L.typeOf(expr));
  switch (member) {
    case "some":
      if (total === 1) return lib("option.some", [at(0)], EFFECT_T, loc);
      break;
    case "none":
      if (total === 0) return lib("option.none", [], EFFECT_T, loc);
      break;
    case "isSome":
    case "isNone":
      if (total === 1 && at(0).type.kind === "effect") {
        const test = lib("option.isSome", [at(0)], BOOL, loc);
        return member === "isSome" ? test : { kind: "unary", op: "!", operand: test, type: BOOL, loc };
      }
      break;
    case "getOrUndefined":
      if (total === 1 && at(0).type.kind === "effect") return lib("option.getOrUndefined", [at(0)], result(), loc);
      break;
    case "getOrElse": {
      if (total !== 2 || at(0).type.kind !== "effect") break;
      const orElse = at(1);
      if (orElse.type.kind !== "func" || orElse.type.params.length !== 0) break;
      return lib("option.getOrElse", [at(0), orElse], result(), loc);
    }
    case "map": {
      if (total !== 2 || at(0).type.kind !== "effect") break;
      const fn = at(1);
      if (fn.type.kind !== "func" || fn.type.params.length !== 1) break;
      return lib("option.map", [at(0), fn], EFFECT_T, loc);
    }
    case "match": {
      // `Option.match(o, { onNone: () => B, onSome: (a) => B })`
      const options = args[total - 1 - pre.length + (pre.length === 0 ? 0 : 0)];
      if (total !== 2 || at(0).type.kind !== "effect" || options === undefined || !ts.isObjectLiteralExpression(options)) break;
      const property = (name: string): ts.Expression | null => {
        const found = options.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
        return found !== undefined && ts.isPropertyAssignment(found) ? found.initializer : null;
      };
      const onNone = property("onNone");
      const onSome = property("onSome");
      if (onNone === null || onSome === null || options.properties.length !== 2) break;
      const none = L.lowerExpr(onNone);
      const some = L.lowerExpr(onSome);
      if (none.type.kind !== "func" || none.type.params.length !== 0 || some.type.kind !== "func" || some.type.params.length !== 1) break;
      return lib("option.match", [at(0), none, some], result(), loc);
    }
    default:
      break;
  }
  return L.unsupported("SC1090", expr, `the effect kernel does not cover Option.${member} in this call shape yet`);
}

/** A logger message argument as the text effect's default logger prints: strings as they are, numbers and booleans
 * through ToString, everything else through Node's inspect at console depth. */
function logPart(L: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  const value = L.lowerExpr(node);
  if (value.type.kind === "string") return value;
  if (value.type.kind === "f64" || value.type.kind === "bool") return { kind: "toString", operand: value, type: STRING, loc };
  return lowerConsoleInspectArg(L, node, value, "Effect.log", loc);
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
  if (body !== undefined && (ts.isArrowFunction(body) || (ts.isFunctionExpression(body) && body.asteriskToken === undefined))) {
    // `Effect.fn("name")((input) => effect)`: the function IS the value (the span is not observable natively).
    const plain = L.lowerExpr(body);
    if (plain.type.kind !== "func" || plain.type.ret.kind !== "effect") L.unsupported("SC1090", expr, "the effect kernel covers Effect.fn over a function returning an effect");
    if (expr.arguments.length === 1) return plain;
    L.unsupported("SC1090", expr, "the effect kernel covers pipeline steps after a generator body only");
  }
  if (body === undefined || !ts.isFunctionExpression(body) || body.asteriskToken === undefined) {
    L.unsupported("SC1090", expr, "the effect kernel covers Effect.fn over a generator function (with optional pipeline steps)");
  }
  const lowered = L.lowerExpr(body);
  if (lowered.type.kind !== "func" || lowered.type.ret.kind !== "generator" || lowered.type.ret.yieldT.kind !== "effect") {
    L.unsupported("SC1090", expr, "the effect kernel covers Effect.fn over a generator body yielding effects");
  }
  const type: IrType = { kind: "func", params: lowered.type.params, ret: EFFECT_T };
  const steps = expr.arguments.slice(1);
  if (steps.length === 0) return lib("effect.fn", [lowered], type, loc);
  // `Effect.fn("name")(function* …, step, …)`: the steps apply to each call's effect — a lifted `(e) => e.pipe(steps)`
  // function value the runtime callback runs over the generated effect (module-scope references only: the steps lower
  // in their own function context).
  const post = liftedPipeline(L, steps, loc);
  return lib("effect.fnPipe", [lowered, post], type, loc);
}

/** The lifted post-processing function of an Effect.fn pipeline, as a closure value `(effect) => effect`. */
function liftedPipeline(L: Lowerer, steps: ts.Expression[], loc: SrcLoc): IrExpr {
  const name = `%effect.fnpost.${L.liftedFns.length}`;
  const funcType: IrType = { kind: "func", params: [EFFECT_T], ret: EFFECT_T };
  L.fnStack.push(newFnCtx(false, null, null, EFFECT_T));
  try {
    const local: IrLocal = { id: "e.0", name: "e", type: EFFECT_T, mutable: false };
    L.ctx.locals.push(local);
    let acc: IrExpr = { kind: "varRef", localId: local.id, type: EFFECT_T, loc };
    for (const step of steps) acc = applyPipeStep(L, acc, step, loc);
    L.liftedFns.push({ name, params: [{ localId: local.id, name: local.name, type: EFFECT_T }], returnType: EFFECT_T, locals: L.ctx.locals, body: [{ kind: "return", value: acc, loc }], loc });
  } finally {
    L.fnStack.pop();
  }
  return { kind: "closure", fnName: name, captures: [], type: funcType, loc };
}

/** One data-last combinator applied to an accumulated effect (`.pipe(Effect.map(f))`, `pipe(e, Effect.orDie)`): the
 * combinator call with the effect prepended lowers through the data-first table. */
function applyPipeStep(L: Lowerer, source: IrExpr, step: ts.Expression, loc: SrcLoc): IrExpr {
  const schemaStep = applySchemaPipeStep(L, source, step, loc);
  if (schemaStep !== null) return schemaStep;
  if (ts.isPropertyAccessExpression(step) && ts.isIdentifier(step.name) && effectNamespaceOf(L, step.expression) === "Effect") {
    const bare: Record<string, IrLibFn | undefined> = { asVoid: "effect.asVoid", ignore: "effect.ignore", orDie: "effect.orDie", scoped: "effect.scoped", exit: "effect.exit" };
    const fn = bare[step.name.text];
    if (fn !== undefined) return lib(fn, [source], EFFECT_T, loc);
    // No interruption in the kernel: both wrappers are the identity, as a bare step too.
    if (step.name.text === "uninterruptible" || step.name.text === "interruptible") return source;
    L.unsupported("SC1090", step, `the effect kernel does not cover Effect.${step.name.text} as a pipe step yet`);
  }
  if (ts.isCallExpression(step) && ts.isPropertyAccessExpression(step.expression) && ts.isIdentifier(step.expression.name)) {
    const stepNs = effectNamespaceOf(L, step.expression.expression);
    if (stepNs === "Effect") return lowerEffectMember(L, step.expression.name.text, [source], [...step.arguments], step, loc);
    if (stepNs === "Option") return lowerOptionMember(L, step.expression.name.text, [source], [...step.arguments], step, loc);
    if (stepNs === "Layer") return lowerLayerMember(L, step.expression.name.text, [source], [...step.arguments], step, loc);
  }
  const program = applyProgramPipeStep(L, source, step, loc);
  if (program !== null) return program;
  return L.unsupported("SC1090", step, "the effect kernel covers pipe steps that are Effect.* combinators or one-parameter function values");
}

/** `Effect.member(...)` → the kernel's lib call, or null when the callee
 * is not an effect namespace member (the call chain keeps trying). */
export function lowerEffectCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const callee = expr.expression;
  const asFn = lowerEffectFn(L, expr, loc);
  if (asFn !== null) return asFn;
  const test = L.dynamic ? null : lowerSchemaTest(L, expr, loc);
  if (test !== null) return test;
  // `pipe(effect, step, …)` (effect's Function.pipe) and `effect.pipe(step, …)` fold the steps left to right.
  const free = effectExportOf(L, callee);
  if (free !== null && free.module === "Function" && free.name === "pipe" && expr.arguments.length >= 1) {
    let acc = L.lowerExpr(expr.arguments[0]!);
    if (acc.type.kind !== "effect") L.unsupported("SC1090", expr, "the effect kernel covers pipe over an Effect value");
    for (const step of expr.arguments.slice(1)) acc = applyPipeStep(L, acc, step, loc);
    return acc;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) && callee.name.text === "pipe" && !callee.questionDotToken && isSchemaLike(L, callee.expression)) {
    let acc = unwrapSchema(L, L.lowerExpr(callee.expression), callee.expression, "pipe");
    for (const step of expr.arguments) acc = applyPipeStep(L, acc, step, loc);
    return acc;
  }
  // `semaphore.withPermits(n)(effect)`: the permit count curries, so the CALL of the call is the whole form.
  if (!L.dynamic && ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && ts.isIdentifier(callee.expression.name) &&
    callee.expression.name.text === "withPermits" && callee.arguments.length === 1 && expr.arguments.length === 1) {
    const semaphore = L.lowerExpr(callee.expression.expression);
    const permits = L.lowerExpr(callee.arguments[0]!);
    const body = L.lowerExpr(expr.arguments[0]!);
    if (semaphore.type.kind === "effect" && permits.type.kind === "f64" && body.type.kind === "effect") {
      return lib("effect.semaphoreWithPermits", [semaphore, permits, body], EFFECT_T, loc);
    }
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null;
  if (!L.dynamic && !callee.questionDotToken && (callee.name.text === "make" || callee.name.text === "annotate" || callee.name.text === "check") && isSchemaLike(L, callee.expression)) {
    const method = lowerSchemaHandleMethod(L, callee.name.text, callee.expression, [...expr.arguments], expr, loc);
    if (method !== null) return method;
  }
  if (!L.dynamic && !callee.questionDotToken && callee.name.text === "make") {
    const made = lowerSchemaClassMake(L, callee.expression, expr, loc);
    if (made !== null) return made;
  }
  if (callee.name.text === "of" && expr.arguments.length === 1 && !L.dynamic) {
    // `Service.of(impl)` on a kernel service key: effect's `of` is the identity over the service shape.
    const recv = callee.expression;
    const sym = ts.isIdentifier(recv) ? L.resolveValueSymbol(recv) : ts.isPropertyAccessExpression(recv) ? L.checker.getSymbolAtLocation(recv.name) : undefined;
    if (kernelServiceIdOfSymbol(L.checker, sym ?? undefined) !== null) {
      const shape = L.mapTypeOf(L.typeOf(expr));
      if (shape === null) L.badType(expr, L.typeOf(expr));
      return L.lowerExprExpecting(expr.arguments[0]!, shape);
    }
  }
  const ns = effectNamespaceOf(L, callee.expression);
  if (ns === null) return null;
  if (ns === "Layer") return lowerLayerMember(L, callee.name.text, [], [...expr.arguments], expr, loc);
  if (ns === "Schema") return lowerSchemaMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "Duration") return lowerDurationMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "Exit") return lowerExitMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "Option") return lowerOptionMember(L, callee.name.text, [], [...expr.arguments], expr, loc);
  if (ns === "Ref" || ns === "SynchronizedRef") return lowerRefMember(L, ns, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "Deferred") return lowerDeferredMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "Semaphore") return lowerSemaphoreMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "Queue") return lowerQueueMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "PubSub") return lowerPubSubMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns === "Cause") return lowerCauseMember(L, callee.name.text, [...expr.arguments], expr, loc);
  if (ns !== "Effect") L.unsupported("SC1090", expr, `the effect kernel does not cover ${ns}.${callee.name.text} yet`);
  return lowerEffectMember(L, callee.name.text, [], [...expr.arguments], expr, loc);
}

/** Synchronized refs serialize every write across effect suspension. Ref keeps
 * its ordinary synchronous cell behavior. Tuple-returning modify operations
 * still need their own carrier and remain refused. */
function lowerRefMember(L: Lowerer, ns: string, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const at = (index: number): IrExpr => L.lowerExpr(args[index]!);
  const refused = (): never => L.unsupported("SC1090", expr, `the effect kernel does not cover ${ns}.${member} yet`);
  switch (member) {
    case "make":
    case "makeUnsafe":
      if (args.length !== 1) refused();
      return lib(ns === "SynchronizedRef" ? (member === "make" ? "effect.syncRefMake" : "effect.syncRefMakeUnsafe") : (member === "make" ? "effect.refMake" : "effect.refMakeUnsafe"), [at(0)], EFFECT_T, loc);
    case "get":
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      return lib("effect.refGet", [at(0)], EFFECT_T, loc);
    case "set":
    case "getAndSet":
      if (args.length !== 2 || at(0).type.kind !== "effect") refused();
      // A replacement is a value even when the cell stores a function.
      return lib("effect.refSet", [at(0), at(1), numLit(member === "getAndSet" ? 1 : 0, loc)], EFFECT_T, loc);
    case "update":
    case "updateAndGet": {
      if (args.length !== 2) refused();
      const cell = at(0);
      const fn = at(1);
      if (cell.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length > 1) refused();
      const keep = member === "update" ? 0 : 2;
      return lib("effect.refUpdate", [cell, fn, numLit(keep, loc)], EFFECT_T, loc);
    }
    case "updateEffect": {
      if (args.length !== 2) refused();
      const cell = at(0);
      const fn = at(1);
      if (cell.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length > 1 || fn.type.ret.kind !== "effect") refused();
      return lib("effect.refUpdateEffect", [cell, fn], EFFECT_T, loc);
    }
    default:
      return refused();
  }
}

/** `Deferred`: a latch settled once, awaited by any number of fibers. `await` parks the fiber on the kernel's own
 * waiter queue (the same machine `Effect.promise` suspends on), and the settling effect answers whether IT settled. */
function lowerDeferredMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const at = (index: number): IrExpr => L.lowerExpr(args[index]!);
  const refused = (): never => L.unsupported("SC1090", expr, `the effect kernel does not cover Deferred.${member} yet`);
  switch (member) {
    case "make":
      if (args.length !== 0) refused();
      return lib("effect.deferredMake", [], EFFECT_T, loc);
    case "await":
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      return lib("effect.deferredAwait", [at(0)], EFFECT_T, loc);
    case "succeed":
    case "fail": {
      if (args.length !== 2 || at(0).type.kind !== "effect") refused();
      return lib("effect.deferredSettle", [at(0), at(1), { kind: "boolLit", value: member === "succeed", type: { kind: "bool" }, loc }], EFFECT_T, loc);
    }
    case "isDone":
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      return lib("effect.deferredIsDone", [at(0)], EFFECT_T, loc);
    default:
      return refused();
  }
}

/** `Semaphore`: permits over the same waiter queue. `withPermits(n)(effect)` takes n, runs, and releases however the
 * effect ends — a released permit hands straight to the longest-waiting fiber. */
function lowerSemaphoreMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const at = (index: number): IrExpr => L.lowerExpr(args[index]!);
  const refused = (): never => L.unsupported("SC1090", expr, `the effect kernel does not cover Semaphore.${member} yet`);
  if ((member === "make" || member === "makeUnsafe") && args.length === 1 && at(0).type.kind === "f64") {
    return lib(member === "make" ? "effect.semaphoreMake" : "effect.semaphoreMakeUnsafe", [at(0)], EFFECT_T, loc);
  }
  return refused();
}

/** `Queue`: items with the fibers waiting to take and the fibers waiting for room. `unbounded` never blocks;
 * `bounded(n)` parks the offering fiber when full, `dropping(n)` refuses the item, `sliding(n)` evicts the oldest. */
function lowerQueueMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const at = (index: number): IrExpr => L.lowerExpr(args[index]!);
  const refused = (): never => L.unsupported("SC1090", expr, `the effect kernel does not cover Queue.${member} yet`);
  const INF = Number.MAX_SAFE_INTEGER;
  switch (member) {
    case "unbounded":
      if (args.length > 1) refused();
      return lib("effect.queueMake", [numLit(INF, loc), numLit(0, loc)], EFFECT_T, loc);
    case "bounded":
    case "dropping":
    case "sliding": {
      if (args.length !== 1 || at(0).type.kind !== "f64") refused();
      const strategy = member === "bounded" ? 0 : member === "dropping" ? 1 : 2;
      return lib("effect.queueMake", [at(0), numLit(strategy, loc)], EFFECT_T, loc);
    }
    case "take":
    case "size":
    case "shutdown":
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      return lib(member === "take" ? "effect.queueTake" : member === "size" ? "effect.queueSize" : "effect.queueShutdown", [at(0)], EFFECT_T, loc);
    case "offer":
      if (args.length !== 2 || at(0).type.kind !== "effect") refused();
      return lib("effect.queueOffer", [at(0), at(1)], EFFECT_T, loc);
    default:
      return refused();
  }
}

/** `PubSub`: subscriptions use queue handles and are released by their acquiring scope or hub shutdown. */
function lowerPubSubMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const at = (index: number): IrExpr => L.lowerExpr(args[index]!);
  const refused = (): never => L.unsupported("SC1090", expr, `the effect kernel does not cover PubSub.${member} yet`);
  const INF = Number.MAX_SAFE_INTEGER;
  switch (member) {
    case "unbounded":
      if (args.length > 1) refused();
      return lib("effect.pubsubMake", [numLit(INF, loc), numLit(0, loc)], EFFECT_T, loc);
    case "bounded":
    case "dropping":
    case "sliding": {
      if (args.length !== 1 || at(0).type.kind !== "f64") refused();
      return lib("effect.pubsubMake", [at(0), numLit(member === "bounded" ? 0 : member === "dropping" ? 1 : 2, loc)], EFFECT_T, loc);
    }
    case "subscribe":
    case "shutdown":
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      return lib(member === "subscribe" ? "effect.pubsubSubscribe" : "effect.pubsubShutdown", [at(0)], EFFECT_T, loc);
    // A Subscription IS the kernel's queue, so its own take and size are the queue's.
    case "take":
    case "size":
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      return lib(member === "take" ? "effect.queueTake" : "effect.queueSize", [at(0)], EFFECT_T, loc);
    case "publish":
      if (args.length !== 2 || at(0).type.kind !== "effect") refused();
      return lib("effect.pubsubPublish", [at(0), at(1)], EFFECT_T, loc);
    default:
      return refused();
  }
}

/** `Cause`: failures, defects and interruptions, including combined finalizer reasons. */
function lowerCauseMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const at = (index: number): IrExpr => L.lowerExpr(args[index]!);
  const refused = (): never => L.unsupported("SC1090", expr, `the effect kernel does not cover Cause.${member} yet`);
  switch (member) {
    case "fail":
      if (args.length !== 1) refused();
      return lib("effect.causeFail", [at(0)], EFFECT_T, loc);
    case "squash": {
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      // A Cause<E> may contain a defect or interruption even when E is never.
      // Squash returns unknown: reconstruct the actual box at that dynamic site.
      const causeTs = L.typeOf(args[0]!);
      const errorTs = L.checker.getTypeArguments(causeTs as ts.TypeReference)[0];
      const carried = errorTs === undefined ? null : L.mapTypeOf(errorTs);
      if (carried === null) refused();
      const site = L.mapTypeOf(L.typeOf(expr));
      if (site === null || site.kind !== "dyn") refused();
      // effect types the result `unknown`: the value rides the site's checked-dynamic slot, which only takes what
      // the dynamic tier can hold (a class instance cannot cross it).
      if (carried?.kind !== "void" && !canConvertToDyn(carried as IrType, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
        L.unsupported("SC1090", expr, `Cause.squash into a checked-dynamic slot for the '${L.fmt(carried as IrType)}' failure channel (only values the dynamic tier holds cross it)`);
      }
      if (carried?.kind === "void") return lib("effect.causeSquash", [at(0)], DYN, loc);
      // Retain the declared carrier so native emission can still reconstruct
      // typed composite failures, with dynamic fallback for other causes.
      return { kind: "dynFrom", value: lib("effect.causeSquash", [at(0)], carried as IrType, loc), type: DYN, loc };
    }
    case "hasDies":
    case "hasInterrupts":
    case "hasInterruptsOnly":
      if (args.length !== 1 || at(0).type.kind !== "effect") refused();
      return lib("effect.causeHas", [at(0), numLit(member === "hasDies" ? 0 : member === "hasInterrupts" ? 1 : 2, loc)], { kind: "bool" }, loc);
    default:
      return refused();
  }
}

/** The SUCCESS type argument of an `Effect<A, E, R>` (or `Effect<…>[]`'s element's) TS type, or null. */
function effectSuccessOf(L: Lowerer, type: ts.Type): ts.Type | null {
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  if (sym?.name !== "Effect") return null;
  return L.checker.getTypeArguments(type as ts.TypeReference)[0] ?? null;
}

/** The RESULT CARRIER of a collection combinator: an expression whose TYPE tells the emitter how to rebuild the typed
 * result from the kernel's boxed values — an empty array literal of the element type, a `record:<shape>` string for a
 * tuple/record, the undefined unit for `discard`. */
function collectionCarrier(L: Lowerer, success: IrType | null, discard: boolean, expr: ts.Node, loc: SrcLoc): IrExpr {
  if (discard) return { kind: "strLit", value: "discard", type: STRING, loc };
  if (success?.kind === "array") {
    if (!isSupportedArrayElem(success.elem)) L.unsupported("SC1090", expr, `the effect kernel cannot collect '${L.fmt(success.elem)}' elements`);
    return { kind: "arrayLit", elems: [], type: success, loc };
  }
  if (success?.kind === "record") return { kind: "strLit", value: `record:${success.shapeId}`, type: STRING, loc };
  return L.unsupported("SC1090", expr, "the effect kernel collects into arrays, tuples and records");
}

/** Collection options must be fully checked: ignoring concurrency can deadlock
 * effects that depend on one another, and skipping expressions loses effects. */
function discardOption(L: Lowerer, options: ts.Expression | undefined, expr: ts.Node): boolean {
  if (options === undefined) return false;
  if (!ts.isObjectLiteralExpression(options)) return L.unsupported("SC1090", expr, "the effect kernel reads combinator options from an object literal");
  let discard = false;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return L.unsupported("SC1090", expr, "combinator option shape");
    const value = property.initializer;
    if (property.name.text === "discard") {
      if (value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword) {
        return L.unsupported("SC1090", value, "the effect kernel requires a literal boolean discard option");
      }
      discard = value.kind === ts.SyntaxKind.TrueKeyword;
    } else if (property.name.text === "concurrency") {
      if (!ts.isNumericLiteral(value) || Number(value.text) !== 1) {
        return L.unsupported("SC1090", value, "the effect kernel supports only literal concurrency: 1; concurrent and inherited execution are not implemented yet");
      }
    } else {
      return L.unsupported("SC1090", property, `the effect kernel does not honor the '${property.name.text}' option yet`);
    }
  }
  return discard;
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
    case "effectDiscard": {
      if (total !== 1 || at(0).type.kind !== "effect") break;
      return lib("layer.effectDiscard", [at(0)], EFFECT_T, loc);
    }
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
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length > 1) break;
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
      case "catchCause": {
        // The failure reaches the handler as a Cause. A DEFECT still unwinds the program: the kernel raises defects
        // as throws, which never reach a frame (effect would answer a Die cause here).
        if (total !== 2) break;
        const source = at(0);
        const fn = at(1);
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length > 1 || fn.type.ret.kind !== "effect") break;
        return lib("effect.catchCause", [source, fn], EFFECT_T, loc);
      }
      case "catch": // effect 4's name for catchAll (v3's spelling is kept for programs written against it)
      case "catchAll":
      case "mapError": {
        if (total !== 2) break;
        const source = at(0);
        const fn = at(1);
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length > 1) break;
        if (member !== "mapError" && fn.type.ret.kind !== "effect") break;
        return lib(member === "mapError" ? "effect.mapError" : "effect.catchAll", [source, fn], EFFECT_T, loc);
      }
      case "promise": {
        if (total !== 1) break;
        const thunk = at(0);
        if (thunk.type.kind !== "func" || thunk.type.params.length !== 0 || thunk.type.ret.kind !== "promise") break;
        return lib("effect.promise", [thunk], EFFECT_T, loc);
      }
      case "try": {
        // `Effect.try({ try: () => value, catch: (reason) => error })` — the throw reaches `catch` as the program's dynamic value.
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
        if (attempt.type.kind !== "func" || attempt.type.params.length !== 0) break;
        if (recover.type.kind !== "func" || recover.type.params.length > 1 || (recover.type.params.length === 1 && recover.type.params[0]!.kind !== "dyn")) break;
        return lib("effect.try", [attempt, recover], EFFECT_T, loc);
      }
      case "orElseSucceed": {
        if (total !== 2 || at(0).type.kind !== "effect") break;
        const orElse = at(1);
        if (orElse.type.kind !== "func" || orElse.type.params.length !== 0) break;
        return lib("effect.orElseSucceed", [at(0), orElse], EFFECT_T, loc);
      }
      case "catchIf": {
        if (total !== 3 || at(0).type.kind !== "effect") break;
        const predicate = at(1);
        const handler = at(2);
        if (predicate.type.kind !== "func" || predicate.type.params.length !== 1 || predicate.type.ret.kind !== "bool") break;
        if (handler.type.kind !== "func" || handler.type.params.length > 1 || handler.type.ret.kind !== "effect") break;
        return lib("effect.catchIf", [at(0), predicate, handler], EFFECT_T, loc);
      }
      case "catchTag": {
        // `Effect.catchTag("Tag", (e) => …)` — the failure whose `_tag` is the literal; the handler's parameter is the checker's narrowing (the class the tag names).
        if (total !== 3 || at(0).type.kind !== "effect") break;
        const tag = at(1);
        let handler = at(2);
        if (tag.kind !== "strLit") L.unsupported("SC1090", expr, "Effect.catchTag with a non-literal tag");
        if (handler.type.kind !== "func" || handler.type.params.length > 1 || handler.type.ret.kind !== "effect") break;
        if (handler.type.params.length === 0) {
          // The contextual callback contract retains the tag-narrowed error
          // even when the implementation ignores it. Reuse the ordinary
          // function adapter so capture and evaluation semantics stay intact.
          const node = args[2 - pre.length];
          const contextual = node === undefined ? undefined : L.checker.getContextualType(node);
          const signature = contextual === undefined ? undefined : L.checker.getCallSignatures(contextual)[0];
          const parameter = signature?.getParameters()[0];
          const type = parameter === undefined ? null : L.mapTypeOf(L.checker.getTypeOfSymbol(parameter));
          if (type === null) L.unsupported("SC1090", expr, "Effect.catchTag without a representable contextual error type");
          handler = L.coerceInto(expr, handler, { kind: "func", params: [type], ret: EFFECT_T });
        }
        return lib("effect.catchTag", [at(0), tag, handler], EFFECT_T, loc);
      }
      case "isEffect": {
        // A value the checker already types as an Effect IS one; a union with an effect arm tests its tag.
        if (total !== 1) break;
        const value = at(0);
        if (value.type.kind === "effect") return { kind: "boolLit", value: true, type: { kind: "bool" }, loc };
        if (value.type.kind === "union") {
          const union = L.unions.get(value.type.unionId);
          const tag = union?.arms.findIndex((arm) => arm.kind === "effect") ?? -1;
          if (union !== undefined && tag >= 0) {
            return { kind: "unionIsTag", unionId: value.type.unionId, tag, negated: false, value, type: { kind: "bool" }, loc };
          }
        }
        break;
      }
      case "tryPromise": {
        // The single-thunk form: a rejection becomes effect's UnknownException (a kernel data handle whose
        // `_tag` and `message` read like effect's).
        if (pre.length === 0 && total === 1 && args[0] !== undefined && !ts.isObjectLiteralExpression(args[0]!)) {
          const attempt = at(0);
          if (attempt.type.kind === "func" && attempt.type.params.length === 0 && attempt.type.ret.kind === "promise") {
            return lib("effect.tryPromiseUnknown", [attempt], EFFECT_T, loc);
          }
          break;
        }
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
      case "log": case "logInfo": case "logWarning": case "logError": case "logDebug": case "logTrace": {
        if (pre.length !== 0) break;
        const level = { log: "INFO", logInfo: "INFO", logWarning: "WARN", logError: "ERROR", logDebug: "DEBUG", logTrace: "TRACE" }[member]!;
        const parts: IrExpr = { kind: "arrayLit", elems: args.map((node) => logPart(L, node, loc)), type: arrayOf(STRING), loc };
        return lib("effect.log", [{ kind: "strLit", value: level, type: STRING, loc }, parts], EFFECT_T, loc);
      }
      case "tap":
      case "tapError": {
        if (total !== 2 || at(0).type.kind !== "effect") break;
        const fn = at(1);
        if (fn.type.kind !== "func" || fn.type.params.length > 1) break;
        return lib(member === "tap" ? "effect.tap" : "effect.tapError", [at(0), fn], EFFECT_T, loc);
      }
      case "suspend": {
        if (total !== 1) break;
        const thunk = at(0);
        if (thunk.type.kind !== "func" || thunk.type.params.length !== 0 || thunk.type.ret.kind !== "effect") break;
        return lib("effect.suspend", [thunk], EFFECT_T, loc);
      }
      case "withSpan": // tracing spans are not observable natively: the effect passes through
        if ((total === 2 || total === 3) && at(0).type.kind === "effect") return at(0);
        break;
      case "sleep": {
        if (total !== 1) break;
        const duration = at(0);
        if (duration.type.kind === "effect") return lib("effect.sleep", [lib("effect.durationToMillis", [duration], { kind: "f64" }, loc)], EFFECT_T, loc);
        if (duration.type.kind !== "f64" && duration.type.kind !== "string") break;
        return lib("effect.sleep", [duration], EFFECT_T, loc);
      }
      case "scoped":
      case "exit":
        if (total === 1 && at(0).type.kind === "effect") return lib(member === "scoped" ? "effect.scoped" : "effect.exit", [at(0)], EFFECT_T, loc);
        break;
      case "addFinalizer": {
        if (total !== 1) break;
        const fn = at(0);
        if (fn.type.kind !== "func" || fn.type.params.length > 1 || fn.type.ret.kind !== "effect" || (fn.type.params.length === 1 && fn.type.params[0]!.kind !== "effect")) break;
        return lib("effect.addFinalizer", [fn], EFFECT_T, loc);
      }
      case "uninterruptible":
      case "interruptible":
        // The kernel has no interruption yet: a fiber runs to its own end, so both wrappers are the identity.
        if (total === 1 && at(0).type.kind === "effect") return at(0);
        break;
      case "delay": {
        // `Effect.delay(e, duration)`: sleep first, then run — the kernel's sequential zip.
        if (total !== 2) break;
        const source = at(0);
        const duration = at(1);
        if (source.type.kind !== "effect") break;
        const sleep = lib("effect.sleep", [duration], EFFECT_T, loc);
        return lib("effect.andThenEffect", [sleep, source], EFFECT_T, loc);
      }
      case "tapCause": {
        // The failure is observed as a Cause and then re-raised: catchCause running the callback and failing again.
        if (total !== 2) break;
        const source = at(0);
        const fn = at(1);
        if (source.type.kind !== "effect" || fn.type.kind !== "func" || fn.type.params.length > 1 || fn.type.ret.kind !== "effect") break;
        return lib("effect.tapErrorCause", [source, fn], EFFECT_T, loc);
      }
      case "ensuring":
        if (total === 2 && at(0).type.kind === "effect" && at(1).type.kind === "effect") return lib("effect.ensuring", [at(0), at(1)], EFFECT_T, loc);
        break;
      case "acquireRelease": {
        if (total !== 2 || at(0).type.kind !== "effect") break;
        const release = at(1);
        if (release.type.kind !== "func" || release.type.params.length === 0 || release.type.params.length > 2 || release.type.ret.kind !== "effect") break;
        return lib("effect.acquireRelease", [at(0), release], EFFECT_T, loc);
      }
      case "acquireUseRelease": {
        if (total !== 3 || at(0).type.kind !== "effect") break;
        const use = at(1);
        const release = at(2);
        if (use.type.kind !== "func" || use.type.params.length !== 1 || use.type.ret.kind !== "effect") break;
        if (release.type.kind !== "func" || release.type.params.length === 0 || release.type.params.length > 2 || release.type.ret.kind !== "effect") break;
        return lib("effect.acquireUseRelease", [at(0), use, release], EFFECT_T, loc);
      }
      case "forEach": {
        // `Effect.forEach(items, (a, i) => effect, { discard })`: sequential; the result array's element type is the callback's success type.
        if (pre.length !== 0 || total < 2 || total > 3) break;
        const items = at(0);
        const fn = at(1);
        if (!["array", "map", "set"].includes(items.type.kind) || fn.type.kind !== "func" || fn.type.params.length > 2 || fn.type.ret.kind !== "effect") break;
        const signature = L.checker.getCallSignatures(L.typeOf(args[1]!))[0];
        const success = signature === undefined ? null : effectSuccessOf(L, L.checker.getReturnTypeOfSignature(signature));
        const discard = discardOption(L, args[2], expr);
        const carrier = collectionCarrier(L, discard || success === null ? null : arrayOf(L.mapTypeOf(success) ?? L.badType(args[1]!, success)), discard, expr, loc);
        return lib("effect.forEach", [items, fn, carrier], EFFECT_T, loc);
      }
      case "all": {
        // `Effect.all([e1, e2])` (tuple), `Effect.all(effects)` (array), `Effect.all({ a: e1, b: e2 })` (record), `{ discard }`.
        if (pre.length !== 0 || total < 1 || total > 2) break;
        const source = args[0]!;
        const discard = discardOption(L, args[1], expr);
        const successTs = effectSuccessOf(L, L.typeOf(expr));
        const success = successTs === null ? null : L.mapTypeOf(successTs);
        let effects: IrExpr;
        if (ts.isArrayLiteralExpression(source)) {
          const elems = source.elements.map((element) => L.lowerExpr(element));
          if (elems.some((e) => e.type.kind !== "effect")) break;
          effects = { kind: "arrayLit", elems, type: arrayOf(EFFECT_T), loc };
        } else if (ts.isObjectLiteralExpression(source)) {
          if (success?.kind !== "record") break;
          const shape = L.shapes.get(success.shapeId);
          const byName = new Map<string, ts.Expression>();
          for (const property of source.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return L.unsupported("SC1090", expr, "Effect.all over a record of plain properties");
            byName.set(property.name.text, property.initializer);
          }
          const elems = (shape?.fields ?? []).map((field) => { const init = byName.get(field.name); return init === undefined ? L.unsupported("SC1090", expr, `Effect.all record field '${field.name}'`) : L.lowerExpr(init); });
          if (elems.some((e) => e.type.kind !== "effect")) break;
          effects = { kind: "arrayLit", elems, type: arrayOf(EFFECT_T), loc };
        } else {
          effects = at(0);
          if (effects.type.kind !== "array" || effects.type.elem.kind !== "effect") break;
        }
        return lib("effect.all", [collectionCarrier(L, success, discard, expr, loc), effects], EFFECT_T, loc);
      }
      case "provideService":
        if (total === 3 && at(0).type.kind === "effect" && at(1).type.kind === "effect") return lib("effect.provideService", [at(0), at(1), at(2)], EFFECT_T, loc);
        break;
      case "service":
        if (total === 1 && at(0).type.kind === "effect") return at(0); // a key IS the effect that looks the service up
        break;
      case "runSyncExit": {
        // A pending fiber becomes a Failure Exit; runSync(exit(e)) would throw.
        if (total !== 1 || at(0).type.kind !== "effect") break;
        return lib("effect.runSyncExit", [at(0)], EFFECT_T, loc);
      }
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
