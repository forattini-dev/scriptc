import * as ts from "./ts7/adapter.js";
import { STRING, UNDEFINED_T, type IrType } from "../ir/ir.js";
import { isDeclaredInAmbientModule, isDeclaredInAmbientNamespace } from "./ambient-declarations.js";
import type { TypeMapperCtx } from "./type-mapper.js";

/** Bun's public options interface is data, including when it types a function value. */
export function mapBunWhichOptions(type: ts.Type, ctx: TypeMapperCtx): IrType | undefined {
  const symbol = type.getSymbol();
  if (symbol?.name !== "WhichOptions" || !ctx.checker.declarationsOf(symbol).some(decl =>
    ts.isInterfaceDeclaration(decl) && ctx.isStdlibFile(decl.getSourceFile()) &&
    (isDeclaredInAmbientModule(decl, "bun") || isDeclaredInAmbientNamespace(decl, "Bun")))) return undefined;
  const optional: IrType = { kind: "union", unionId: ctx.unions.intern([STRING, UNDEFINED_T]) };
  return { kind: "record", shapeId: ctx.shapes.intern([{ name: "PATH", type: optional }, { name: "cwd", type: optional }], false, undefined, ["PATH", "cwd"]) };
}
