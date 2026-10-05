// Non-u8 typed arrays cannot yet cross the checked-native dynamic boundary.
function copy(value) { return Buffer.from(value).toString('hex'); }
console.log(copy(new Uint32Array([0x12345678, 257, 4294967295])));
console.log(copy(new Float64Array([258.9, -1.5, NaN, Infinity])));
