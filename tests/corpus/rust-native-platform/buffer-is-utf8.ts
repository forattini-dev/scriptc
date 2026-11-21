import { isUtf8 } from "node:buffer";

console.log(isUtf8(Buffer.from([65, 66])));
console.log(isUtf8(Buffer.from([0xc3, 0xa9])));
console.log(isUtf8(Buffer.from([0xc3, 0x28])));
console.log(isUtf8(Buffer.from([65, 66, 0xc3]).subarray(0, 2)));
