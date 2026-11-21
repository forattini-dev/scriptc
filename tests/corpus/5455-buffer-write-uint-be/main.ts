import { Buffer } from "node:buffer";

const bytes = Buffer.alloc(10);
console.log(bytes.writeUInt16BE(0x1234, 0));
console.log(bytes.writeUIntBE(0x010203040506, 2, 6));
console.log(bytes.subarray(0, 8).join(","));
