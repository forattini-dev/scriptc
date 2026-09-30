// @rust-only
// The incremental Hash/Hmac HANDLE surface, as distinct from the fused
// createHash(a).update(x).digest(e) chain the compiler folds into one call.
// Every handle here is stored in a binding, so the chain fast path stands
// down and the per-step libcalls run: new, update (string and bytes, with
// and without an input encoding), copy, and both terminal digests.
// Digests are deterministic, so they print in full — a wrong byte fails.
import { createHash, createHmac } from "node:crypto";
import * as crypto from "node:crypto";

function caught(run: () => void): string {
  try {
    run();
    return "no-throw";
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return `${err.name}/${err.code ?? "none"}`;
  }
}

// --- Hash: incremental updates, both terminal digest forms -------------
const sha256 = createHash("sha256");
sha256.update("abc");
sha256.update(Buffer.from("def", "utf8"));
sha256.update("676869", "hex");
sha256.update("utf8 tail ☃", "utf8");
console.log("sha256-hex", sha256.digest("hex"));

const sha256Buffer = createHash("sha256");
sha256Buffer.update("abcdefghi");
const digestBytes = sha256Buffer.digest();
console.log("sha256-buffer", digestBytes.length, digestBytes.toString("hex"));

// The same input through both terminal forms must agree.
const asString = createHash("sha512");
asString.update("agreement");
const asBytes = createHash("sha512");
asBytes.update("agreement");
console.log("terminal-agree", asString.digest("hex") === asBytes.digest().toString("hex"));

// base64 is the other accepted digest encoding.
const md5 = createHash("md5");
md5.update("base64 please");
console.log("md5-base64", md5.digest("base64"));

// Every supported algorithm, through the handle path, with its digest
// length — a wrong algorithm table shows up here immediately.
const sha1 = createHash("sha1");
sha1.update("lengths");
const sha384 = createHash("sha384");
sha384.update("lengths");
console.log("lengths", sha1.digest().length, sha384.digest().length);

// --- hash.copy(): the two handles must be INDEPENDENT ------------------
const base = createHash("sha256");
base.update("shared-prefix");
const branch = base.copy();
// Diverge both sides. Neither write may be visible to the other.
base.update("-left");
branch.update("-right");
const expectedLeft = createHash("sha256");
expectedLeft.update("shared-prefix");
expectedLeft.update("-left");
const expectedRight = createHash("sha256");
expectedRight.update("shared-prefix");
expectedRight.update("-right");
console.log("copy-left", base.digest("hex") === expectedLeft.digest("hex"));
console.log("copy-right", branch.digest("hex") === expectedRight.digest("hex"));

// A copy taken and NOT written to must equal the original's continuation.
const twinSource = createHash("sha256");
twinSource.update("twin");
const twin = twinSource.copy();
console.log("copy-twin", twinSource.digest("hex") === twin.digest("hex"));

// Finalizing a copy must not finalize its origin.
const originAlive = createHash("sha256");
originAlive.update("origin");
const doomed = originAlive.copy();
doomed.digest("hex");
originAlive.update("-still-open");
const expectedAlive = createHash("sha256");
expectedAlive.update("origin");
expectedAlive.update("-still-open");
console.log("copy-origin-open", originAlive.digest("hex") === expectedAlive.digest("hex"));

// --- Hmac: string and byte keys, incremental updates ------------------
const hmacStr = createHmac("sha256", "string-key");
hmacStr.update("one");
hmacStr.update(Buffer.from("two", "utf8"));
console.log("hmac-str-hex", hmacStr.digest("hex"));

const hmacBytes = createHmac("sha256", Buffer.from("string-key", "utf8"));
hmacBytes.update("one");
hmacBytes.update(Buffer.from("two", "utf8"));
const hmacBytesDigest = hmacBytes.digest();
console.log("hmac-bytes-buffer", hmacBytesDigest.length, hmacBytesDigest.toString("hex"));

// A string key and the same bytes as a key must produce the same MAC.
const keyAsString = createHmac("sha1", "same");
keyAsString.update("payload");
const keyAsBytes = createHmac("sha1", Buffer.from("same", "utf8"));
keyAsBytes.update("payload");
console.log("hmac-key-agree", keyAsString.digest("hex") === keyAsBytes.digest("hex"));

const hmacEncoded = createHmac("sha256", "k");
hmacEncoded.update("616263", "hex");
console.log("hmac-hex-input", hmacEncoded.digest("base64"));

// The namespace spelling reaches the same handles.
const viaNamespace = crypto.createHash("sha256");
viaNamespace.update("namespace");
const viaNamed = createHash("sha256");
viaNamed.update("namespace");
console.log("namespace-agree", viaNamespace.digest("hex") === viaNamed.digest("hex"));

// --- terminal state: Node's exact (and asymmetric) behaviour ----------
// Hash: update or digest after digest throws ERR_CRYPTO_HASH_FINALIZED.
const finalizedHash = createHash("sha256");
finalizedHash.update("done");
finalizedHash.digest("hex");
console.log("hash-update-after", caught(() => void finalizedHash.update("late")));
console.log("hash-digest-after", caught(() => void finalizedHash.digest("hex")));
console.log("hash-copy-after", caught(() => void finalizedHash.copy()));

// Hmac: update after digest throws, but a SECOND digest answers empty
// instead of throwing. That asymmetry is Node's, so it is pinned here.
const finalizedHmac = createHmac("sha256", "key");
finalizedHmac.update("done");
finalizedHmac.digest();
console.log("hmac-update-after", caught(() => void finalizedHmac.update("late")));
console.log("hmac-digest-after", JSON.stringify(finalizedHmac.digest("hex")));

console.log("done");
