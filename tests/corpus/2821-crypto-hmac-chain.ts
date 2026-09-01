// The fused HMAC chain — createHmac(alg, key).update(data).digest(enc).
// RFC 4231/RFC 2202 vectors, both import spellings, string and Buffer
// keys and data, hex and base64 digests, and the key-length branches: a
// short key (zero-padded), a key exactly at the block size, and an
// oversized key (hashed down first) for both the 64-byte and 128-byte
// block families.
import { createHmac } from "node:crypto";
import * as crypto from "node:crypto";

const key1 = Buffer.alloc(20, 0x0b);

// RFC 4231 test case 1.
console.log(createHmac("sha256", key1).update("Hi There").digest("hex"));
console.log(createHmac("sha384", key1).update("Hi There").digest("hex"));
console.log(createHmac("sha512", key1).update("Hi There").digest("hex"));
// RFC 2202 test case 1 (the same message under HMAC-SHA-1).
console.log(createHmac("sha1", key1).update("Hi There").digest("hex"));

// RFC 4231 test case 2: a short ASCII string key.
console.log(crypto.createHmac("sha256", "Jefe").update("what do ya want for nothing?").digest("hex"));
console.log(crypto.createHmac("sha512", "Jefe").update("what do ya want for nothing?").digest("hex"));

// base64 digests.
console.log(createHmac("sha256", "key").update("msg").digest("base64"));
console.log(createHmac("sha512", "key").update("msg").digest("base64"));

// An empty key and an empty message.
console.log(createHmac("sha256", "").update("").digest("hex"));
console.log(createHmac("sha512", Buffer.alloc(0)).update("").digest("hex"));

// Key-length branches. 64 bytes is the SHA-1/SHA-256 block size, 128 the
// SHA-384/SHA-512 one; a longer key is hashed down before padding.
console.log(createHmac("sha256", Buffer.alloc(64, 0xaa)).update("data").digest("hex"));
console.log(createHmac("sha256", Buffer.alloc(65, 0xaa)).update("data").digest("hex"));
console.log(createHmac("sha256", Buffer.alloc(131, 0xaa)).update("data").digest("hex"));
console.log(createHmac("sha512", Buffer.alloc(128, 0xaa)).update("data").digest("hex"));
console.log(createHmac("sha512", Buffer.alloc(129, 0xaa)).update("data").digest("hex"));
console.log(createHmac("sha384", Buffer.alloc(200, 0xaa)).update("data").digest("hex"));

// Buffer data, including NULs and high bytes, and multi-block messages.
console.log(createHmac("sha256", "k").update(Buffer.from([0, 1, 2, 255, 128, 0])).digest("hex"));
console.log(createHmac("sha512", key1).update(Buffer.from("abc", "utf8")).digest("hex"));
console.log(createHmac("sha512", "k").update("a".repeat(300)).digest("hex"));

// A non-ASCII string key and message hash their UTF-8 bytes.
console.log(createHmac("sha256", "ünïcode-key ✓").update("héllo wörld ✓").digest("hex"));

// The webhook-signature idiom: a computed key and a template message.
const secret = "shhh-" + String(40 + 2);
const body = JSON.stringify({ id: 7, name: "widget" });
console.log(createHmac("sha256", secret).update(body).digest("hex"));
