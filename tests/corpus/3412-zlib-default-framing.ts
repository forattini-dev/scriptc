// @rust-only
// @no-engine
import { deflateSync, deflateRawSync, gzipSync, inflateSync, inflateRawSync, gunzipSync } from "node:zlib";

const text = "abc".repeat(89);
const input = Buffer.from(text);
const wrapped = deflateSync(input);
const raw = deflateRawSync(input);
const gzip = gzipSync(input);
console.log(wrapped.toString("hex"));
console.log(raw.toString("hex"));
console.log(gzip.toString("hex"));
console.log(inflateSync(wrapped).toString("utf8") === text);
console.log(inflateRawSync(raw).toString("utf8") === text);
console.log(gunzipSync(gzip).toString("utf8") === text);
