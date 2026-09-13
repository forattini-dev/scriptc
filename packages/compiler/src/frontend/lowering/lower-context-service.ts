import * as ts from "../ts7/adapter.js";
import { EFFECT_T, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Context.Service.use is flatMap over the service lookup. Recognize its
 * declaration, including generic parameters and aliases, rather than the
 * spelling of a user's method or the broad opaque Effect representation. */
export function lowerContextServiceUse(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const callee = expr.expression;
  if (L.dynamic || expr.questionDotToken || !ts.isPropertyAccessExpression(callee) ||
      callee.questionDotToken || !ts.isIdentifier(callee.name) || callee.name.text !== "use") return null;
  const symbol = L.checker.getSymbolAtLocation(callee.name);
  if (!symbol || !L.checker.declarationsOf(symbol).some(decl =>
    decl.kind === ts.SyntaxKind.MethodSignature && ts.isInterfaceDeclaration(decl.parent) && decl.parent.name.text === "Service" &&
    /[\\/]node_modules[\\/]effect[\\/]dist[\\/]Context\.d\.ts$/.test(decl.getSourceFile().fileName))) return null;
  const argument = expr.arguments[0];
  if (!argument || expr.arguments.length !== 1 || ts.isSpreadElement(argument)) {
    return L.unsupported("SC1090", expr, "native Context.Service.use requires one callback without spread arguments");
  }
  const service = L.lowerExpr(callee.expression);
  const callback = L.lowerExpr(argument);
  if (service.type.kind !== "effect" || callback.type.kind !== "func" ||
      callback.type.params.length !== 1 || callback.type.ret.kind !== "effect") {
    return L.unsupported("SC1090", expr, "native Context.Service.use requires a service key and a one-parameter callback returning an Effect");
  }
  return { kind: "libCall", fn: "effect.flatMap", args: [service, callback], type: EFFECT_T, loc };
}
