// The one-shot zlib/raw-DEFLATE/gzip codecs with default options.
// Compressed BYTES are zlib-version-dependent, so only round-trip results,
// format markers, and fixed-blob inflation print — never compressed output.
// crypto.randomBytes remains beside them as a real Buffer with the composed
// .toString path unchanged.
import { randomBytes } from "node:crypto";
import {
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
  unzipSync,
} from "node:zlib";

const raw = Buffer.from("hello hello hello hello compression works", "utf8");
const packed = deflateSync(raw);
console.log("smaller", packed.length > 0, packed.length < raw.length);
console.log("header", packed[0]);
console.log("rt", inflateSync(packed).toString() === raw.toString());
console.log("rthex", inflateSync(packed).toString("hex") === raw.toString("hex"));

const rawPacked = deflateRawSync(raw);
console.log("raw", rawPacked.length > 0, inflateRawSync(rawPacked).equals(raw));

const gzipPacked = gzipSync(raw);
console.log("gzip-header", gzipPacked.subarray(0, 2).toString("hex"));
console.log("gzip", gunzipSync(gzipPacked).equals(raw));
console.log("unzip", unzipSync(packed).equals(raw), unzipSync(gzipPacked).equals(raw));

// A fixed blob deflated by zlib once (any zlib inflates it identically).
const fixed = Buffer.from("789c2b29ce4b2cc92c4b05000fa2036f", "hex");
console.log("fixed", inflateSync(fixed).toString());

// Fixed gzip/raw-DEFLATE blobs for decoder evidence independent of each
// encoder in this binary.
const fixedGzip = Buffer.from(
  "1f8b08000000000000132b2e492cc94c5648ce4f494d5648cbac28292d4a05007d4d0da114000000",
  "hex",
);
const fixedRaw = Buffer.from("2b2e492cc94c5648ce4f494d5648cbac28292d4a0500", "hex");
console.log("fixed-gzip", gunzipSync(fixedGzip).toString());
console.log("fixed-raw", inflateRawSync(fixedRaw).toString());

const empty = deflateSync(new Uint8Array(0));
console.log("empty", inflateSync(empty).length);

try {
  inflateSync(Buffer.from("00112233", "hex"));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) {
    console.log("corrupt", e.message);
  }
}
try {
  inflateSync(packed.slice(0, packed.length - 4));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) {
    console.log("truncated", e.message);
  }
}
try {
  gunzipSync(gzipPacked.subarray(0, gzipPacked.length - 4));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) {
    console.log("gzip-truncated", e.message);
  }
}

const r = randomBytes(16);
console.log("rand", r.length, r.byteLength);
console.log("randcopy", new Uint8Array(r).length);
console.log("rand0", randomBytes(0).length);
console.log("randtrunc", randomBytes(2.7).length);
// The composed string form stays one fused operation, identical results.
console.log("composed", randomBytes(8).toString("hex").length);
try {
  randomBytes(-1);
  console.log("no-throw");
} catch (e) {
  if (e instanceof RangeError) {
    console.log("range", e.message);
  }
}
