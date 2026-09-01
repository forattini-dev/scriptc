// zlib's one-shot family beyond the deflate/inflate pair: gzipSync and
// gunzipSync, unzipSync over BOTH wrapper formats, and the raw pair.
// Compressed BYTES are zlib-version-dependent, so only round-trip results
// and the fixed gzip framing (magic + method + flags) print; the corrupt
// blobs are fixed hex so every lane sees the same bytes.
import {
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  unzipSync,
} from "node:zlib";

const raw = Buffer.from("hello hello hello hello compression works", "utf8");
const zipped = gzipSync(raw);
console.log("magic", zipped[0], zipped[1], zipped[2], zipped[3]);
console.log("gzrt", gunzipSync(zipped).toString() === raw.toString());
console.log("unzip-gzip", unzipSync(zipped).toString() === raw.toString());
console.log("unzip-zlib", unzipSync(deflateSync(raw)).toString());
console.log("gzempty", gunzipSync(gzipSync(new Uint8Array(0))).length);

// A gzip member produced once by zlib: every decoder reads it identically.
const fixedHex =
  "1f8b0800000000000003cb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b0112ce94d829000000";
console.log("fixed", gunzipSync(Buffer.from(fixedHex, "hex")).toString());
console.log("fixedunzip", unzipSync(Buffer.from(fixedHex, "hex")).toString("hex").length);

const rawDeflated = deflateRawSync(raw);
console.log("rawrt", inflateRawSync(rawDeflated).toString() === raw.toString());
console.log("rawsmaller", rawDeflated.length < raw.length);
console.log("rawempty", inflateRawSync(deflateRawSync(new Uint8Array(0))).length);
// gzip framing wraps exactly that raw stream: 10 header + 8 trailer bytes.
console.log("framing", zipped.length === rawDeflated.length + 18);
console.log(
  "rawfixed",
  inflateRawSync(Buffer.from("cb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b01", "hex"))
    .toString(),
);

try {
  gunzipSync(Buffer.from("00112233", "hex"));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) console.log("badmagic", e.message);
}
try {
  // The fixed member without its 4-byte length trailer.
  gunzipSync(Buffer.from(fixedHex.slice(0, fixedHex.length - 8), "hex"));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) console.log("truncated", e.message);
}
try {
  // One CRC32 byte flipped: the payload inflates, its checksum does not match.
  gunzipSync(Buffer.from(`${fixedHex.slice(0, fixedHex.length - 15)}d${fixedHex.slice(fixedHex.length - 14)}`, "hex"));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) console.log("badcrc", e.message);
}
try {
  // The stored length says 40 bytes where 41 came out.
  gunzipSync(Buffer.from(`${fixedHex.slice(0, fixedHex.length - 8)}28000000`, "hex"));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) console.log("badlen", e.message);
}
try {
  unzipSync(Buffer.from("00112233", "hex"));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) console.log("unzipbad", e.message);
}
try {
  gunzipSync(new Uint8Array(0));
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) console.log("gzempty-in", e.message);
}
