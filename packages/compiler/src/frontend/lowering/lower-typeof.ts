import * as ts from "../ts7/adapter.js";
import { BOOL, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { activeRuntimeTarget } from "../../compat/runtime-target.js";
import type { Lowerer } from "./lowerer.js";

/** Only capability queries are modeled here. Reading or invoking an
 * unsupported runtime API still goes through the ordinary native fence.
 * Mutating these global objects is likewise outside the native surface. */
function runtimeCapability(L: Lowerer, operand: ts.Expression): string | null {
  // An engine can own mutable globals; its values must remain runtime reads.
  if (L.dynamic) return null;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (!ts.isPropertyAccessExpression(operand) || operand.questionDotToken) return null;
  const root = operand.expression;
  if (ts.isIdentifier(root) && root.text === "globalThis") {
    // Unlike the intrinsic, a JS parameter/local named globalThis has a
    // source declaration. Do not confuse it with the actual global object.
    const symbol = L.checker.getSymbolAtLocation(root);
    if (symbol && L.checker.declarationsOf(symbol).some(d => !L.isStdlibFile(d.getSourceFile()))) return null;
    const member = L.checker.getSymbolAtLocation(operand.name);
    if (member && !L.isStdlibSymbol(member)) return null;
    if (operand.name.text === "Bun") return activeRuntimeTarget().bunGlobal ? "object" : "undefined";
    if (operand.name.text === "Deno") return "undefined";
  }
  // Bun's spawn is a function on the Bun target even when calling it has
  // no native implementation yet. On Node an unguarded .spawn would throw;
  // do not invent a value for that access. The caller lowers && lazily.
  if (operand.name.text === "spawn" && ts.isPropertyAccessExpression(root) &&
      root.name.text === "Bun" && runtimeCapability(L, root) === "object") return "function";
  return null;
}

export function lowerBuiltinTypeof(L: Lowerer, expr: ts.TypeOfExpression, loc: SrcLoc): IrExpr | null {
  const capability = runtimeCapability(L, expr.expression);
  if (capability !== null) return { kind: "strLit", value: capability, type: STRING, loc };
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "navigator" &&
    L.isStdlibSymbol(L.checker.getSymbolAtLocation(expr.expression))
  ) {
    return { kind: "strLit", value: "object", type: STRING, loc };
  }
  // UMD bundles probe browser/loader globals that do not exist on the
  // Node compatibility targets. The shipped ambient declarations let
  // the checker describe the dead branches; this provenance-checked
  // fold gives `typeof` Node's non-throwing "undefined" answer before
  // an ordinary identifier read can become a ReferenceError.
  if (
    ts.isIdentifier(expr.expression) &&
    (expr.expression.text === "define" ||
      expr.expression.text === "window" ||
      expr.expression.text === "self") &&
    L.isStdlibSymbol(L.checker.getSymbolAtLocation(expr.expression))
  ) {
    return { kind: "strLit", value: "undefined", type: STRING, loc };
  }
  // The POSIX identity methods are linked native capabilities on every
  // host scriptc supports. Their optional Node declarations exist for
  // Windows, but the compiled target's direct and optional calls both
  // already lower to the runtime functions; the matching capability
  // probe must therefore answer "function" without materializing a
  // bound method value.
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const processMember = L.stdlibGlobalMember(expr.expression, "process");
    if (processMember === "getuid" || processMember === "getgid") {
      return { kind: "strLit", value: "function", type: STRING, loc };
    }
  }
  // `typeof queueMicrotask` / `typeof DOMException` on a STDLIB global
  // whose declared type is callable or constructable: folds to
  // "function" BEFORE the operand lowers — the identity-token story
  // (JS files) deliberately represents these values as strings, and
  // the TS-file fence would name a value the program never needs; an
  // identifier read has no side effects to preserve. Node's answer for
  // every function and constructor global is "function" (the harness's
  // `typeof queueMicrotask === 'function'` probes). Shadowing locals
  // have non-stdlib symbols and keep the ordinary path.
  if (ts.isIdentifier(expr.expression)) {
    const sym = L.checker.getSymbolAtLocation(expr.expression);
    if (L.isStdlibSymbol(sym)) {
      const t = L.typeOf(expr.expression);
      if (
        L.checker.getCallSignatures(t).length > 0 ||
        L.checker.getConstructSignatures(t).length > 0
      ) {
        return { kind: "strLit", value: "function", type: STRING, loc };
      }
    }
  }
  return null;
}

/** Run before generic dyn/union tests: their checker types may describe an
 * absent ambient global as any, but reading that value is unnecessary. */
export function lowerBuiltinTypeofTest(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
  for (const [a, b] of [[expr.left, expr.right], [expr.right, expr.left]]) {
    if (!a || !b || !ts.isTypeOfExpression(a) || !ts.isStringLiteral(b)) continue;
    const answer = lowerBuiltinTypeof(L, a, loc);
    if (answer?.kind !== "strLit") continue;
    const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    return { kind: "boolLit", value: (answer.value === b.text) !== negated, type: BOOL, loc };
  }
  return null;
}
