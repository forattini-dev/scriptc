/* Why a type did NOT map, in words a reader can act on. The record twin (describeRecordMemberBlocker, types.ts)
 * names a member; this one names a signature's parameter or return, so the dynamic-family diagnostic can say which
 * part of `(input: X) => Y` blocks the whole function. */
import * as ts from "./ts7/adapter.js";
import { TypeMapperCtx, mapType } from "./type-mapper.js";

/** The STATIC reason a SIGNATURE type did not map: the first parameter or the return that has no static shape.
 * The record twin of this (describeRecordMemberBlocker) names a member; this one names a slot, so the
 * dynamic-family diagnostic can say WHICH part of `(input: X) => Y` blocks the whole function. */
export function describeSignatureBlocker(widened: ts.Type, ctx: TypeMapperCtx): string | null {
  const { checker } = ctx;
  const sigs = checker.getCallSignatures(widened);
  if (sigs.length !== 1 || checker.getConstructSignatures(widened).length > 0) return null;
  const sig = sigs[0]!;
  if ((sig.getTypeParameters()?.length ?? 0) > 0) return null;
  for (const p of sig.getParameters()) {
    const paramTs = checker.getTypeOfSymbol(p);
    if (mapType(paramTs, ctx) === null) {
      return `the function shape is supported, but its parameter '${p.name}' has type '${checker.typeToString(paramTs)}', which does not compile`;
    }
  }
  const retTs = checker.getReturnTypeOfSignature(sig);
  if (mapType(retTs, ctx) === null) {
    return `the function shape is supported, but its return type '${checker.typeToString(retTs)}' does not compile`;
  }
  return null;
}
