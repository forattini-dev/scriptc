import * as ts from "../ts7/adapter.js";
import { BYTES_U8, DYN, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { dynUndefinedExpr } from "./lowerer.js";
import { zlibInputBytes } from "./lower-zlib.js";

export function registerPromisifiedZlibRaw(
  lowerer: Lowerer,
  nameNode: ts.Node,
  target: { module: string; member: string } | null,
): boolean {
  if (target?.module !== "zlib" || (target.member !== "deflateRaw" && target.member !== "inflateRaw")) return false;
  if (!ts.isIdentifier(nameNode) || !ts.isVariableDeclaration(nameNode.parent) ||
      !ts.isVariableDeclarationList(nameNode.parent.parent) || !(nameNode.parent.parent.flags & ts.NodeFlags.Const)) {
    lowerer.noLowering("a mutable promisified zlib binding", nameNode, "declare a const binding and call it directly");
  }
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  if (symbol) lowerer.promisifiedZlibRaw.set(symbol, target.member);
  return true;
}

/** Keep the original error-first codec's deferred completion: this is not
 * an async helper around a synchronous codec or an already-settled promise. */
export function lowerPromisifiedZlibRawCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  target: "deflateRaw" | "inflateRaw",
  loc: SrcLoc,
): IrExpr {
  const maxArgs = target === "deflateRaw" ? 2 : 1;
  const [input, options] = call.arguments;
  if (!input || call.arguments.length > maxArgs || call.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering(`promisified zlib.${target} arguments`, call, "supported: string or Buffer/Uint8Array input, with a literal { level } for deflateRaw");
  }
  const args = [zlibInputBytes(lowerer, input, loc)];
  if (target === "deflateRaw") args.push(rawDeflateLevel(lowerer, options, loc));
  return {
    kind: "libCall", fn: target === "deflateRaw" ? "zlib.deflateRawAsync" : "zlib.inflateRawAsync",
    args,
    type: { kind: "promise", inner: BYTES_U8 }, loc,
  };
}

function rawDeflateLevel(lowerer: Lowerer, options: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  if (options === undefined) return dynUndefinedExpr(loc);
  if (!ts.isObjectLiteralExpression(options)) {
    lowerer.noLowering("promisified deflateRaw options", options, "supported: a literal { level } option");
  }
  const [property] = options.properties;
  if (!property || options.properties.length !== 1) {
    lowerer.noLowering("promisified deflateRaw options", options, "supported: a literal { level } option");
  }
  const value = ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "level" ? property.name
    : ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "level" ? property.initializer
    : null;
  if (!value) lowerer.noLowering("promisified deflateRaw options", options, "supported: a literal { level } option");
  // Do not dynCheck before the promise exists: Node rejects invalid levels,
  // rather than throwing out of the promisified call synchronously.
  const level = lowerer.lowerExpr(value);
  return level.type.kind === "dyn" ? level : { kind: "dynFrom", value: level, type: DYN, loc: level.loc };
}
