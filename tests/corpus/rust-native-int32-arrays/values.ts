// @rust-only
// @no-engine
const signed = new Int32Array([0, -1, 2147483648, 4294967295, 4294967297, 1.9, -1.9, 0 / 0, 1 / 0]);
const unsigned = new Uint32Array([0, -1, 2147483648, 4294967295, 4294967297, 1.9, -1.9, 0 / 0, 1 / 0]);
console.log("signed", signed.join(), signed.length, signed.byteLength);
console.log("unsigned", unsigned.join(), unsigned.length, unsigned.byteLength);
const alias = signed;
const sub = signed.subarray(1, 4);
const copy = signed.slice(1, 4);
sub[0] = 4294967295;
sub[1] = 4294967297;
console.log("aliases", alias.join(), sub.join(), copy.join());
const copied = new Uint32Array(signed);
console.log("copy", copied.join());
