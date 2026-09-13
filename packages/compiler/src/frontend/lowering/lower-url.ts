import * as ts from "../ts7/adapter.js";
import { BOOL, STRING, URL_T, VOID, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { nodeThrowExpr, type Lowerer } from "./lowerer.js";

export function lowerUrlNew(lowerer: Lowerer, expr: ts.NewExpression, symbol: ts.Symbol | null): IrExpr | null {
  if (!symbol || symbol.name !== "URL" || !lowerer.isStdlibSymbol(symbol)) return null;
  const loc = locOf(expr);
  const args = expr.arguments ?? [];
  if (args.length < 1 || args.length > 2) {
    lowerer.noLowering(
      `new URL with ${args.length} argument${args.length === 1 ? "" : "s"}`,
      expr,
      "a string input and an optional string or URL base are the supported forms",
      symbol,
    );
  }
  const input = lowerer.lowerExprExpecting(args[0]!, STRING);
  if (args.length === 2) {
    const baseNode = args[1]!;
    // A URL base uses its current serialization, after the input and base
    // expressions have evaluated. This keeps mutations in either visible.
    const base: IrExpr = lowerer.mapTypeOf(lowerer.typeOf(baseNode))?.kind === "url"
      ? { kind: "libCall", fn: "url.href", args: [lowerer.lowerExpr(baseNode)], type: STRING, loc: locOf(baseNode) }
      : lowerer.lowerExprExpecting(baseNode, STRING);
    return { kind: "libCall", fn: "url.newBase", args: [input, base], type: URL_T, loc };
  }
  return { kind: "libCall", fn: "url.new", args: [input], type: URL_T, loc };
}

/** URL.revokeObjectURL() with NO argument: Node's ERR_MISSING_ARGS
 * throws before the registry lookup, so the zero-argument contract is
 * exact without any blob machinery. The one-argument form (Node's
 * silent no-op for unregistered ids) and createObjectURL keep their
 * fences — a compiled program has no blob registry to consult.
 *
 * URL.canParse(input) is `new URL(input)`'s accept/reject as a boolean,
 * answered by the same parser and never throwing. The base form shares
 * the constructor's relative-reference resolution. */
export function lowerUrlStaticCall(lowerer: Lowerer, call: ts.CallExpression, callee: ts.Expression): IrExpr | null {
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
  if (!ts.isIdentifier(callee.expression)) return null;
  const sym = lowerer.resolveValueSymbol(callee.expression);
  if (!sym || sym.name !== "URL" || !lowerer.isStdlibSymbol(sym)) return null;
  const member = callee.name.text;
  if (member === "canParse") {
    if (call.arguments.length < 1 || call.arguments.length > 2) {
      lowerer.noLowering(
        `URL.canParse with ${call.arguments.length} argument${call.arguments.length === 1 ? "" : "s"}`,
        call,
        "a string input and an optional string base are the supported forms",
        sym,
      );
    }
    const input = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
    if (call.arguments.length === 2) {
      const base = lowerer.lowerExprExpecting(call.arguments[1]!, STRING);
      return { kind: "libCall", fn: "url.canParseBase", args: [input, base], type: BOOL, loc: locOf(call) };
    }
    return { kind: "libCall", fn: "url.canParse", args: [input], type: BOOL, loc: locOf(call) };
  }
  if (member !== "revokeObjectURL" || call.arguments.length !== 0) return null;
  return nodeThrowExpr(1, "ERR_MISSING_ARGS", 'The "url" argument must be specified', VOID, locOf(call));
}
