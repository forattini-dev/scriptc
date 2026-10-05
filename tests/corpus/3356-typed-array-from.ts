const input = [0, -1, 4294967297, 3.9, -3.9, NaN, Infinity];
const unsigned = Uint32Array.from(input);
const signed = Int32Array.from(input);
console.log(unsigned[0], unsigned[1], unsigned[2], unsigned[3], unsigned[4], unsigned[5], unsigned[6]);
console.log(signed[0], signed[1], signed[2], signed[3], signed[4], signed[5], signed[6]);
input[0] = 99;
const copy = Uint32Array.from(unsigned);
copy[0] = 42;
console.log(unsigned[0], copy[0]);
const small = Uint8Array.from([257, -1, 1.9]);
console.log(small[0], small[1], small[2]);
const floats = Float32Array.from([1.5, -2.25]);
console.log(floats[0], floats[1]);
const doubles = Float64Array.from([1.5, -2.25]);
console.log(doubles[0], doubles[1]);
console.log(Int32Array.from([]).length);
let evaluations = 0;
function source(): number[] { evaluations++; return [7, 8]; }
const once = Uint32Array.from(source());
console.log(once[0], once[1], evaluations);
function shadow(Uint32Array: { from: (xs: number[]) => number }): number {
  return Uint32Array.from([10]);
}
console.log(shadow({ from: (xs: number[]) => xs[0]! + 1 }));
