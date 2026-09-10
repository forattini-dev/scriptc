// @dynamic
import { make, counts } from "nativeprops";

console.log(make(false).bytes.length);
console.log(make(false).bytes.byteLength);
console.log(make(false).bytes.byteOffset);
console.log(make(false).text.length);
console.log(make(false).items.length);
console.log(make(true).bytes.length);
const saved = make(false).bytes;
console.log(saved.length);
console.log(`${make(false).bytes?.length}`);
console.log(counts());
