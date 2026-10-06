// @rust-only
// @no-engine
import { deflateSync, inflateSync } from "node:zlib";
const data = new Uint8Array(4096);
for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 3)) & 255;
const packed = deflateSync(data, { level: 9 });
const back = inflateSync(packed);
console.log(packed.length, back.length, back[17], back[4095]);
