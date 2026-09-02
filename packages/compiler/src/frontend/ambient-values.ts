import { BOOL, F64, JSVAL, STRING, funcOf, type IrType } from "../ir/nodes.js";
import * as ts from "./ts7/adapter.js";
import type { TypeMapperCtx } from "./types.js";
import type { Lowerer } from "./lowering/lowerer.js";
import type { IrExpr, SrcLoc } from "../ir/nodes.js";

/** Map standard-library values whose runtime representation is not their
 * declaration's structural interface. Provenance is part of this seam: a
 * user declaration with the same spelling must keep normal type mapping. */
export function mapAmbientValueType(
  widened: ts.Type,
  ctx: TypeMapperCtx,
): IrType | null {
  const symbol = widened.getSymbol();
  if (!symbol) return null;
  const declaredByStdlib = ctx.checker
    .declarationsOf(symbol)
    .some((declaration) => ctx.isStdlibFile(declaration.getSourceFile()));
  if (!declaredByStdlib) return null;

  // Box construction is fenced, so every value accepted by these ambient
  // wrapper interfaces uses the corresponding primitive representation.
  if (symbol.name === "Number") return F64;
  if (symbol.name === "String") return STRING;
  if (symbol.name === "Boolean") return BOOL;

  // Stored primitive constructors use one concrete closure ABI. Calls with
  // incompatible arguments are rejected by the ordinary parameter coercion.
  if (
    symbol.name === "StringConstructor" ||
    symbol.name === "NumberConstructor" ||
    symbol.name === "BooleanConstructor"
  ) {
    return funcOf(
      [STRING],
      symbol.name === "StringConstructor"
        ? STRING
        : symbol.name === "NumberConstructor"
          ? F64
          : BOOL,
    );
  }

  // The ambient overloaded fetch function is callable inside the embedded
  // engine. A user function named fetch never reaches this provenance gate.
  if (
    ctx.dynamic &&
    symbol.name === "fetch" &&
    ctx.checker
      .declarationsOf(symbol)
      .some((declaration) => ts.isFunctionDeclaration(declaration))
  ) {
    return JSVAL;
  }
  return null;
}

/** Lower an ambient engine-owned global used as a first-class value. */
export function lowerDynamicGlobalIdentifier(
  lowerer: Lowerer,
  expression: ts.Identifier,
  loc: SrcLoc,
): IrExpr | null {
  if (
    !lowerer.dynamic ||
    expression.text !== "fetch" ||
    !lowerer.isStdlibSymbol(lowerer.checker.getSymbolAtLocation(expression))
  ) {
    return null;
  }
  return {
    kind: "jsOp",
    op: "globalGet",
    name: expression.text,
    args: [],
    type: JSVAL,
    loc,
  };
}
