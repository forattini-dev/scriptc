import * as ts from "./ts7/adapter.js";
import type { TypeMapperCtx } from "./type-mapper.js";
import { isNpmStaticTypeFile } from "./npm-static-types.js";
import { isKernelTypeFile } from "./kernel.js";

/** Effect's native types are structural at every depth, including options
 * and mapped-type members. This admits types, not package implementations:
 * runtime imports and opaque kernel handles keep their separate checks. */
export function isUnmappedRecordDeclaration(sf: ts.SourceFile, ctx: TypeMapperCtx): boolean {
  return sf.isDeclarationFile && !ctx.isExternalTypeFile(sf) && !isNpmStaticTypeFile(sf.fileName) &&
    (ctx.dynamic || !isKernelTypeFile(sf.fileName));
}

/** True for MAPPED-type results — `Partial<Config>`, `Record<"a", n>`,
 * whatever `Pick`/`Omit` reduce to. Their shape is computed by the checker,
 * not declared anywhere: the only declaration behind them is the utility
 * type's `{ [P in keyof T]: ... }` machinery in lib.es5.d.ts. */
export function isMappedShape(t: ts.Type): boolean {
  return (
    (t.flags & ts.TypeFlags.Object) !== 0 &&
    ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0
  );
}

/** The record path's provenance fence. Declared shapes (object literals,
 * interfaces, type literals) must come from user code, a native kernel or
 * an explicitly mapped external surface, never an arbitrary .d.ts — the empty
 * ambient interfaces (Object, Function, Boolean, ...) exist only to
 * satisfy tsc and must not become zero-field records. Checker-COMPUTED
 * shapes (mapped-type results, intersections) have no user declaration to
 * point at: mapped types pass here and get per-MEMBER provenance in the
 * field walk instead; an intersection passes when every part is itself an
 * ordinary provenance-passing object type (class parts keep their nominal
 * identity and never flatten into a struct). */
export function recordProvenanceOk(t: ts.Type, ctx: TypeMapperCtx): boolean {
  const { checker } = ctx;
  if (t.isIntersectionType()) {
    return ts.constituentTypes(t).every(
      (part) => {
        const partSym = part.getSymbol();
        return (part.flags & ts.TypeFlags.Object) !== 0 &&
          !(partSym && partSym.flags & ts.SymbolFlags.Class) &&
          checker.getCallSignatures(part).length === 0 &&
          checker.getConstructSignatures(part).length === 0 &&
          recordProvenanceOk(part, ctx);
      },
    );
  }
  if (isMappedShape(t)) return true;
  const tSym = t.getSymbol();
  const decls = tSym ? checker.declarationsOf(tSym) : undefined;
  if (!decls || decls.length === 0) return false;
  return !decls.some((d) => {
    const sf = d.getSourceFile();
    return isUnmappedRecordDeclaration(sf, ctx);
  });
}
