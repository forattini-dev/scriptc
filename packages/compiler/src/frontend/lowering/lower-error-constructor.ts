import * as ts from "../ts7/adapter.js";
import type { IrExpr, SrcLoc } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { errorWithCause } from "./lower-error-message.js";
import { fenceEarlyAliasUse } from "./lower-namespaces.js";

/** Callable ECMAScript Error builtins use the same construction path as
 * `new`. Resolve declaration identity, not spelling; DOMException and user
 * classes are not callable Error builtins. */
export function lowerBuiltinErrorCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression) || expr.questionDotToken !== undefined) return null;
  const info = L.builtinErrorInfoOf(L.resolveValueSymbol(expr.expression));
  if (!info || info.def.name === "%DOMException") return null;
  fenceEarlyAliasUse(L, expr.expression, expr);
  return lowerBuiltinErrorConstruction(L, expr.arguments, info.def.name, locOf(expr), expr);
}

/** Preserve the existing new-Error argument boundary and evaluation order
 * for both syntactic forms. Unsupported options retain their diagnostic. */
export function lowerBuiltinErrorConstruction(
  L: Lowerer,
  args: readonly ts.Expression[],
  className: string,
  loc: SrcLoc,
  blame: ts.Node,
): IrExpr {
  if (args.length > 2) {
    L.unsupported("SC1090", args[2] ?? blame, "Error constructor arguments after options");
  }
  if (args.length === 2) {
    const options = args[1]!;
    if (!ts.isObjectLiteralExpression(options)) {
      L.unsupported("SC1090", options, "Error constructor options that are not an inline { cause: value } literal");
    }
    let causeNode: ts.Expression | null = null;
    for (const property of options.properties) {
      if (ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === "cause") ||
          (ts.isStringLiteral(property.name) && property.name.text === "cause"))) {
        causeNode = property.initializer;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) &&
        ts.isIdentifier(property.name) && property.name.text === "cause") {
        causeNode = property.name;
        continue;
      }
      L.unsupported("SC1090", property, "Error constructor option other than a plain 'cause' property");
    }
    if (causeNode !== null) return errorWithCause(L, args[0]!, causeNode, className, loc);
  }
  return {
    kind: "libCall", fn: "error.new",
    args: [L.errorMessageArg(args.slice(0, 1), loc, blame)],
    type: { kind: "object", className }, loc,
  };
}
