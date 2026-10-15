import * as ts from "./ts7/adapter.js";
import { isDeclaredInAmbientModule, isDeclaredInAmbientNamespace } from "./ambient-declarations.js";
import type { TypeMapperCtx } from "./type-mapper.js";

/** Only Bun's declared handle owns Bun lifecycle semantics; names on user records do not. */
export function isBunSubprocess(type: ts.Type, ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">): boolean {
  const symbol = type.getSymbol();
  return symbol?.name === "Subprocess" && ctx.checker.declarationsOf(symbol).some(decl =>
    ts.isInterfaceDeclaration(decl) && ctx.isStdlibFile(decl.getSourceFile()) &&
    (isDeclaredInAmbientModule(decl, "bun") || isDeclaredInAmbientNamespace(decl, "Bun")));
}
