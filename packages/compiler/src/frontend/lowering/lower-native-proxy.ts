import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type IrType } from "../../ir/ir.js";
import { nativeArrayViewSupported, nativeRecordShapeSupported } from "../../ir/native-record.js";
import { locOf } from "../program.js";
import { lowerDynObjectLiteral } from "./lower-exprs.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** Proxy is a dynamic reference even when the checker retains the target's
 * structural type. Keep its target and handler as live native references; a
 * subsequent typed view must perform its reads through the proxy. */
export function lowerNativeProxyNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  // Explicit engine builds retain their existing complete Proxy surface.
  if (lowerer.dynamic || stdlibGlobalNameOf(lowerer, expr.expression) !== "Proxy") return null;
  const args = expr.arguments ?? [];
  if (args.length !== 2 || args.some(arg => ts.isSpreadElement(arg))) {
    lowerer.unsupported("SC1090", expr, "native Proxy construction requires a target and a handler without spread arguments");
  }
  const lowerArgument = (arg: ts.Expression, index: number): IrExpr => {
    const boxReference = (node: ts.Expression, raw: IrExpr): IrExpr => {
      if (!proxyReferenceTransportSupported(lowerer, raw.type)) {
        lowerer.unsupported("SC1101", node, `native Proxy ${index === 0 ? "target" : "handler"} requires identity-preserving dynamic transport; '${lowerer.fmt(raw.type)}' would be copied`);
      }
      return lowerer.coerceToExpected(raw, DYN);
    };
    // The handler's standard-library contextual type contains every optional
    // trap. Lower the literal's actual properties and closures instead.
    const raw = ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg, boxReference)
      : lowerer.lowerExpr(arg);
    const value = boxReference(arg, raw);
    if (value.type.kind !== "dyn") {
      lowerer.unsupported("SC1101", arg, `native Proxy argument of type '${lowerer.fmt(raw.type)}' has no dynamic reference representation`);
    }
    return value;
  };
  return { kind: "libCall", fn: "dyn.proxyNew", args: args.map(lowerArgument), type: DYN, loc: locOf(expr) };
}

/** Dyn can serialize more composites than it can share. Proxy construction
 * must retain the original object and every nested value observable through
 * it, including fields and values crossing a trap's parameter/return boundary. */
function proxyReferenceTransportSupported(L: Lowerer, type: IrType): boolean {
  if (type.kind === "func") return type.params.every(param => proxyReferenceTransportSupported(L, param)) && proxyReferenceTransportSupported(L, type.ret);
  if (type.kind === "record") {
    const shape = L.shapes.get(type.shapeId);
    return shape !== undefined && nativeRecordShapeSupported(shape, { get: id => L.unions.get(id) }, id => L.shapes.get(id));
  }
  if (type.kind === "array") return nativeArrayViewSupported(type);
  if (type.kind === "union") return L.unions.get(type.unionId)?.arms.every(arm => proxyReferenceTransportSupported(L, arm)) ?? false;
  return true;
}

/** Inferred Proxy storage keeps the dynamic reference instead of adopting
 * the target's structural type. Explicit annotations still form typed views.
 * Global collection runs before lowering, so use the same constructor
 * provenance there; local declarations check the actual emitted operation. */
export function nativeProxyBindingType(L: Lowerer, decl: ts.VariableDeclaration, init?: IrExpr): IrType | null {
  if (L.dynamic || decl.type || !decl.initializer || !ts.isIdentifier(decl.name)) return null;
  if (init) return init.kind === "libCall" && init.fn === "dyn.proxyNew" ? DYN : null;
  let source = decl.initializer;
  while (ts.isParenthesizedExpression(source)) source = source.expression;
  return ts.isNewExpression(source) && stdlibGlobalNameOf(L, source.expression) === "Proxy" ? DYN : null;
}
