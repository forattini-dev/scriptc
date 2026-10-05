// @rust-only
// @no-engine
import { deflateRawSync, inflateRawSync } from "node:zlib";

const input = Buffer.from("02000302000302", "hex");
const packed = deflateRawSync(input);
console.log(packed.toString("hex"));
console.log(inflateRawSync(packed).toString("hex"));
