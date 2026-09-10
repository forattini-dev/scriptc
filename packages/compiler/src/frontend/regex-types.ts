import * as ts from "./ts7/adapter.js";
import type { TypeMapperCtx } from "./types.js";
import { STRING, UNDEFINED_T, type IrType } from "../ir/nodes.js";

/** Map only the standard library's groups property; user dictionaries keep
 * their own declared value types. This also covers indexed-access aliases. */
export function regexGroupsType(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const symbol = type.getSymbol();
  if (!symbol) return null;
  const owned = ctx.checker.declarationsOf(symbol).some((declaration) => {
    const property = declaration.parent;
    const owner = property?.parent;
    return declaration.kind === ts.SyntaxKind.TypeLiteral && property !== undefined &&
      ts.isPropertySignature(property) && ts.isIdentifier(property.name) && property.name.text === "groups" &&
      owner !== undefined && ts.isInterfaceDeclaration(owner) &&
      (owner.name.text === "RegExpMatchArray" || owner.name.text === "RegExpExecArray") &&
      ctx.isStdlibFile(declaration.getSourceFile());
  });
  if (!owned) return null;
  const value: IrType = { kind: "union", unionId: ctx.unions.intern([STRING, UNDEFINED_T]) };
  return { kind: "record", shapeId: ctx.shapes.intern([], false, value) };
}
