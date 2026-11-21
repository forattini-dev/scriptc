import { createHash } from "node:crypto";

function hashHelper(algorithm: string, value: unknown): string {
  const str = String(value ?? "");
  return createHash(algorithm).update(str).digest("hex");
}

for (const algorithm of ["md5", "sha1", "sha256", "sha512"]) {
  console.log(algorithm, hashHelper(algorithm, "recker"));
}
console.log(hashHelper("sha256", undefined));
try {
  hashHelper("whirlpool-x", "value");
} catch (error) {
  console.log(error instanceof Error, (error as Error).message);
}

import { createHmac } from "node:crypto";

function hmacHelper(algorithm: string, secret: string, value: unknown): string {
  const str = String(value ?? "");
  return createHmac(algorithm, secret).update(str).digest("hex");
}

for (const algorithm of ["sha1", "sha256", "sha512"]) {
  console.log("hmac", algorithm, hmacHelper(algorithm, "s3cr3t", "payload"));
}
console.log(createHmac("sha256", "key").update("").digest("base64"));
try {
  hmacHelper("nope", "k", "v");
} catch (error) {
  console.log(error instanceof TypeError, (error as { code?: string }).code, (error as Error).message);
}
