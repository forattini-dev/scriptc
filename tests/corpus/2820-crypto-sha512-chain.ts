// The wider digests of the fused createHash chain: sha384 and sha512,
// over string and Buffer inputs, hex and base64 outputs, and the block
// boundaries of the 128-byte SHA-512 block (111/112/128/239/240 bytes
// exercise both padding branches). The one-shot crypto.hash static takes
// the same algorithms.
import { createHash, hash } from "node:crypto";
import * as crypto from "node:crypto";

console.log(createHash("sha512").update("").digest("hex"));
console.log(createHash("sha512").update("abc").digest("hex"));
console.log(createHash("sha384").update("").digest("hex"));
console.log(createHash("sha384").update("abc").digest("hex"));
console.log(crypto.createHash("sha512").update("hello world").digest("base64"));
console.log(crypto.createHash("sha384").update("hello world").digest("base64"));

// The SHA-512 padding branches: one block (≤111 bytes of message) and two.
console.log(createHash("sha512").update("a".repeat(111)).digest("hex"));
console.log(createHash("sha512").update("a".repeat(112)).digest("hex"));
console.log(createHash("sha512").update("a".repeat(128)).digest("hex"));
console.log(createHash("sha512").update("a".repeat(239)).digest("hex"));
console.log(createHash("sha512").update("a".repeat(240)).digest("hex"));
console.log(createHash("sha384").update("a".repeat(112)).digest("hex"));
console.log(createHash("sha384").update("a".repeat(200)).digest("hex"));

// Non-ASCII input hashes its UTF-8 bytes (Node's default input encoding).
console.log(createHash("sha512").update("héllo wörld — ünïcode ✓").digest("hex"));

// Buffer input, including NULs and high bytes.
console.log(createHash("sha512").update(Buffer.from([0, 1, 2, 255, 128, 0])).digest("hex"));
console.log(crypto.createHash("sha384").update(Buffer.from("abc", "utf8")).digest("base64"));

// The one-shot static over the same algorithms.
console.log(hash("sha512", "abc"));
console.log(hash("sha384", "abc"));
console.log(hash("sha512", "abc", "base64"));
console.log(hash("sha512", Buffer.from("abc", "utf8")));
