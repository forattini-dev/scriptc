import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustCryptoCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const x509 = X509_CALLS[expr.fn];
  if (x509 !== undefined) {
    const [data] = expr.args;
    if (expr.args.length !== 1 || data === undefined || expr.type.kind !== "string" ||
        (x509.input === "string" ? data.type.kind !== "string" :
          data.type.kind !== "bytes" || data.type.elem !== "u8")) {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::${x509.helper}(&(${context.emitExpr(data)}))`;
  }
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

const X509_CALLS: Readonly<Record<string, { helper: string; input: "bytes" | "string" } | undefined>> = {
  "crypto.x509Fingerprint": { helper: "crypto_x509_fingerprint_bytes", input: "bytes" },
  "crypto.x509FingerprintStr": { helper: "crypto_x509_fingerprint_string", input: "string" },
  "crypto.x509ValidFrom": { helper: "crypto_x509_valid_from_bytes", input: "bytes" },
  "crypto.x509ValidFromStr": { helper: "crypto_x509_valid_from_string", input: "string" },
  "crypto.x509ValidTo": { helper: "crypto_x509_valid_to_bytes", input: "bytes" },
  "crypto.x509ValidToStr": { helper: "crypto_x509_valid_to_string", input: "string" },
};
