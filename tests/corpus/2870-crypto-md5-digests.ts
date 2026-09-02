// MD5 through every lowered crypto surface: the fused createHash chain
// over strings and Buffers, both digest encodings, the crypto.hash
// one-shot, and HMAC-MD5 (RFC 2104 block 64) over string and Buffer keys.
// The first three digests are the RFC 1321 A.5 test-suite vectors, which
// pin the padding: "" and "abc" take one block, the 62-byte alphanumeric
// string takes two (its 0x80 lands past the length field).
import { createHash, createHmac, hash } from "node:crypto";

const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

console.log(createHash("md5").update("").digest("hex"));
console.log(createHash("md5").update("abc").digest("hex"));
console.log(createHash("md5").update(ALPHANUMERIC).digest("hex"));

// A 64-byte input: exactly one block of message, so the padding needs a
// whole SECOND block on its own.
console.log(createHash("md5").update("x".repeat(64)).digest("hex"));
console.log(createHash("md5").update("x".repeat(119)).digest("hex"));
console.log(createHash("md5").update("x".repeat(120)).digest("hex"));

// Non-ASCII hashes its UTF-8 bytes, which is Node's default input encoding.
console.log(createHash("md5").update("café ☕").digest("hex"));
console.log(createHash("md5").update("").digest("base64"));
console.log(createHash("md5").update("scriptc").digest("base64"));

// Buffer input, and a Buffer holding raw bytes rather than text.
console.log(createHash("md5").update(Buffer.from("abc", "utf8")).digest("hex"));
console.log(
  createHash("md5").update(Buffer.from([0, 1, 2, 253, 254, 255])).digest("hex"),
);
console.log(createHash("md5").update(Buffer.from("ff00ff", "hex")).digest("base64"));

// The one-shot, which shares the runtime's digest table with the chain.
console.log(hash("md5", "abc"));
console.log(hash("md5", Buffer.from("abc", "utf8")));

// HMAC-MD5, RFC 2202 test cases 1, 2 and 6: a 16-byte 0x0b key, a short
// ASCII key, and an 80-byte key — longer than the 64-byte block, so the
// key is replaced by its own digest.
console.log(
  createHmac("md5", Buffer.alloc(16, 0x0b)).update("Hi There").digest("hex"),
);
console.log(
  createHmac("md5", "Jefe").update("what do ya want for nothing?").digest("hex"),
);
console.log(
  createHmac("md5", Buffer.alloc(80, 0xaa))
    .update("Test Using Larger Than Block-Size Key - Hash Key First")
    .digest("hex"),
);
console.log(createHmac("md5", "key").update(Buffer.from("msg")).digest("base64"));
console.log(createHmac("md5", Buffer.alloc(64, 0x41)).update("").digest("hex"));
