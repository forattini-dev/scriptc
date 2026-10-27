// @ts-nocheck
// @rust-only
// @no-engine
export {};

const values = new Float32Array([16777216, 0.1, 5, 9]);
console.log('unrounded', values[0] += 1, values[0]);
console.log('assign', values[1] = 0.1, values[1]);
console.log('arithmetic', values[2] *= 3, values[2] /= 2, values[2] %= 4);
console.log('bitwise', values[3] <<= 2, values[3] >>>= 1, values[3] ^= 3);
console.log('string', values[2] += '2', values[2]);
console.log('boolean', values[1] = true, values[1]);
console.log('undefined', values[1] = undefined, values[1]);
const doubles = new Float64Array([16777216]);
console.log('double', doubles[0] += 1, doubles[0]);
