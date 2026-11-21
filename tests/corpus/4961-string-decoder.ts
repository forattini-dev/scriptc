// @rust-only
// @no-engine
import { StringDecoder } from "node:string_decoder";
import { Buffer } from "node:buffer";

const decoder = new StringDecoder("utf8");
const pieces = [
  decoder.write(Buffer.from([0xe2, 0x82])),
  decoder.write(Buffer.from([0xac, 0x61])),
  decoder.end(),
];
console.log(pieces.join("|"));
