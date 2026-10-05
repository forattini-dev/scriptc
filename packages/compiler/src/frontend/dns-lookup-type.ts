import * as ts from "./ts7/adapter.js";
import { isDeclaredInAmbientModule } from "./ambient-declarations.js";
import { F64, NULL_T, STRING, typeKey, type IrType } from "../ir/ir.js";
import type { TypeMapperCtx } from "./type-mapper.js";

/** Canonical native DNS result. Node 24's empty-host result is nullable,
 * even where an installed declaration incorrectly promises only string.
 * User interfaces sharing the name must keep their own structural type. */
export function mapDnsLookupAddress(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const symbol = type.getSymbol();
  if (symbol?.name !== "LookupAddress" || !ctx.checker.declarationsOf(symbol).some(declaration =>
    ts.isInterfaceDeclaration(declaration) && ctx.isStdlibFile(declaration.getSourceFile()) &&
    (isDeclaredInAmbientModule(declaration, "dns") || isDeclaredInAmbientModule(declaration, "dns/promises")))) return null;
  const arms = [NULL_T, STRING].sort((a, b) => typeKey(a).localeCompare(typeKey(b)));
  const address: IrType = { kind: "union", unionId: ctx.unions.intern(arms) };
  return { kind: "record", shapeId: ctx.shapes.intern([
    { name: "address", type: address }, { name: "family", type: F64 },
  ], false, undefined, ["address", "family"]) };
}
