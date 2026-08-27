import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustCryptoCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn !== "crypto.hashDigestStr" && expr.fn !== "crypto.hashDigestBytes") return null;
  const [algorithm, data, encoding] = expr.args;
  const stringData = expr.fn === "crypto.hashDigestStr";
  if (expr.args.length !== 3 || algorithm?.type.kind !== "string" ||
      encoding?.type.kind !== "string" || expr.type.kind !== "string" || data === undefined ||
      (stringData ? data.type.kind !== "string" :
        data.type.kind !== "bytes" || data.type.elem !== "u8")) {
    context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const helper = stringData ? "crypto_hash_digest_string" : "crypto_hash_digest_bytes";
  return `runtime::${helper}(&(${context.emitExpr(algorithm)}), &(${context.emitExpr(data)}), &(${context.emitExpr(encoding)}))`;
}
