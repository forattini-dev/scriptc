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
  if (expr.fn === "crypto.hashNew") {
    const [algorithm] = expr.args;
    if (expr.args.length !== 1 || algorithm?.type.kind !== "string" || expr.type.kind !== "cryptoHash") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::crypto_hash_new(&(${context.emitExpr(algorithm)}))`;
  }
  if (expr.fn === "crypto.hmacNewStr" || expr.fn === "crypto.hmacNewBytes") {
    const [algorithm, key] = expr.args;
    const stringKey = expr.fn === "crypto.hmacNewStr";
    if (expr.args.length !== 2 || algorithm?.type.kind !== "string" || expr.type.kind !== "cryptoHmac" || key === undefined ||
        (stringKey ? key.type.kind !== "string" : key.type.kind !== "bytes" || key.type.elem !== "u8")) {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const helper = stringKey ? "crypto_hmac_new_string" : "crypto_hmac_new_bytes";
    return `runtime::${helper}(&(${context.emitExpr(algorithm)}), &(${context.emitExpr(key)}))`;
  }
  const update = HASH_UPDATE_CALLS[expr.fn];
  if (update !== undefined) {
    const [handle, data] = expr.args;
    if (expr.args.length !== 2 || handle?.type.kind !== update.handle || expr.type.kind !== update.handle || data === undefined ||
        (update.input === "string" ? data.type.kind !== "string" : data.type.kind !== "bytes" || data.type.elem !== "u8")) {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::${update.helper}(&(${context.emitExpr(handle)}), &(${context.emitExpr(data)}))`;
  }
  if (expr.fn === "crypto.hashCopy") {
    const [hash] = expr.args;
    if (expr.args.length !== 1 || hash?.type.kind !== "cryptoHash" || expr.type.kind !== "cryptoHash") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::crypto_hash_copy(&(${context.emitExpr(hash)}))`;
  }
  const handleDigest = HANDLE_DIGEST_CALLS[expr.fn];
  if (handleDigest !== undefined) {
    const [handle, encoding] = expr.args;
    const stringResult = handleDigest.result === "string";
    if (expr.args.length !== (stringResult ? 2 : 1) || handle?.type.kind !== handleDigest.handle ||
        expr.type.kind !== handleDigest.result || (stringResult && encoding?.type.kind !== "string")) {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const suffix = stringResult ? `, &(${context.emitExpr(encoding!)}))` : ")";
    return `runtime::${handleDigest.helper}(&(${context.emitExpr(handle)})${suffix}`;
  }
  if (expr.fn === "crypto.randomFill" || expr.fn === "crypto.randomFillRest") {
    const [bytes, offset, size] = expr.args;
    const explicitSize = expr.fn === "crypto.randomFill";
    if (expr.args.length !== (explicitSize ? 3 : 2) || bytes?.type.kind !== "bytes" || bytes.type.elem !== "u8" ||
        offset?.type.kind !== "f64" || expr.type.kind !== "bytes" || expr.type.elem !== "u8" ||
        (explicitSize && size?.type.kind !== "f64")) {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const helper = explicitSize ? "crypto_random_fill_bytes" : "crypto_random_fill_rest";
    const sizeArg = explicitSize ? `, ${context.emitExpr(size!)}` : "";
    return `runtime::${helper}(&(${context.emitExpr(bytes)}), ${context.emitExpr(offset)}${sizeArg})`;
  }
  if (expr.fn === "crypto.randomInt") {
    const [min, max] = expr.args;
    if (expr.args.length !== 2 || min?.type.kind !== "f64" || max?.type.kind !== "f64" || expr.type.kind !== "f64") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::crypto_random_int(${context.emitExpr(min)}, ${context.emitExpr(max)})`;
  }
  if (expr.fn === "crypto.pbkdf2") {
    const [password, salt, iterations, keyLength, digest] = expr.args;
    if (expr.args.length !== 5 || password?.type.kind !== "bytes" || password.type.elem !== "u8" ||
        salt?.type.kind !== "bytes" || salt.type.elem !== "u8" || iterations?.type.kind !== "f64" ||
        keyLength?.type.kind !== "f64" || digest?.type.kind !== "string" || expr.type.kind !== "bytes" || expr.type.elem !== "u8") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::crypto_pbkdf2(&(${context.emitExpr(password)}), &(${context.emitExpr(salt)}), ` +
      `${context.emitExpr(iterations)}, ${context.emitExpr(keyLength)}, &(${context.emitExpr(digest)}))`;
  }
  if (expr.fn === "crypto.timingSafeEqual") {
    const [first, second] = expr.args;
    if (expr.args.length !== 2 || expr.type.kind !== "bool" ||
        first?.type.kind !== "bytes" || first.type.elem !== "u8" ||
        second?.type.kind !== "bytes" || second.type.elem !== "u8") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::crypto_timing_safe_equal(&(${context.emitExpr(first)}), &(${context.emitExpr(second)}))`;
  }
  if (expr.fn === "crypto.hmacDigestStr" || expr.fn === "crypto.hmacDigestBytes") {
    const [algorithm, key, data, encoding] = expr.args;
    const stringData = expr.fn === "crypto.hmacDigestStr";
    if (expr.args.length !== 4 || algorithm?.type.kind !== "string" ||
        encoding?.type.kind !== "string" || expr.type.kind !== "string" ||
        key?.type.kind !== "bytes" || key.type.elem !== "u8" || data === undefined ||
        (stringData ? data.type.kind !== "string" :
          data.type.kind !== "bytes" || data.type.elem !== "u8")) {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const helper = stringData ? "crypto_hmac_digest_string" : "crypto_hmac_digest_bytes";
    return `runtime::${helper}(&(${context.emitExpr(algorithm)}), &(${context.emitExpr(key)}), ` +
      `&(${context.emitExpr(data)}), &(${context.emitExpr(encoding)}))`;
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

const HASH_UPDATE_CALLS: Readonly<Record<string, {
  helper: string;
  handle: "cryptoHash" | "cryptoHmac";
  input: "string" | "bytes";
} | undefined>> = {
  "crypto.hashUpdateStr": { helper: "crypto_hash_update_string", handle: "cryptoHash", input: "string" },
  "crypto.hashUpdateBytes": { helper: "crypto_hash_update_bytes", handle: "cryptoHash", input: "bytes" },
  "crypto.hmacUpdateStr": { helper: "crypto_hmac_update_string", handle: "cryptoHmac", input: "string" },
  "crypto.hmacUpdateBytes": { helper: "crypto_hmac_update_bytes", handle: "cryptoHmac", input: "bytes" },
};

const HANDLE_DIGEST_CALLS: Readonly<Record<string, {
  helper: string;
  handle: "cryptoHash" | "cryptoHmac";
  result: "string" | "bytes";
} | undefined>> = {
  "crypto.hashDigestString": { helper: "crypto_hash_digest_string_handle", handle: "cryptoHash", result: "string" },
  "crypto.hashDigestBuffer": { helper: "crypto_hash_digest_buffer", handle: "cryptoHash", result: "bytes" },
  "crypto.hmacDigestString": { helper: "crypto_hmac_digest_string_handle", handle: "cryptoHmac", result: "string" },
  "crypto.hmacDigestBuffer": { helper: "crypto_hmac_digest_buffer", handle: "cryptoHmac", result: "bytes" },
};

const X509_CALLS: Readonly<Record<string, { helper: string; input: "bytes" | "string" } | undefined>> = {
  "crypto.x509Fingerprint": { helper: "crypto_x509_fingerprint_bytes", input: "bytes" },
  "crypto.x509FingerprintStr": { helper: "crypto_x509_fingerprint_string", input: "string" },
  "crypto.x509ValidFrom": { helper: "crypto_x509_valid_from_bytes", input: "bytes" },
  "crypto.x509ValidFromStr": { helper: "crypto_x509_valid_from_string", input: "string" },
  "crypto.x509ValidTo": { helper: "crypto_x509_valid_to_bytes", input: "bytes" },
  "crypto.x509ValidToStr": { helper: "crypto_x509_valid_to_string", input: "string" },
};
