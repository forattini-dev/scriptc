import { Buffer } from "node:buffer";

const bytes = Buffer.from([0x12, 0x34, 1, 2, 3, 4, 5, 6]);
console.log(bytes.readUInt16BE(0));
console.log(bytes.readUIntBE(2, 6));
