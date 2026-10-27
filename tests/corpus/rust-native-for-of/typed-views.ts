// @rust-only
// @no-engine
export {};
for (const value of new Uint8Array([1, 255])) console.log("u8", value);
for (const value of new Float32Array([1.5, -2])) console.log("f32", value);
for (const value of new Float64Array([3.25])) console.log("f64", value);
let current = [1, 2];
const original = current;
let order = "";
function source(): number[] { order += "s"; return current; }
function right(): number { order += "r"; current = [7, 8]; return 9; }
source()[1] = right();
console.log("write-owner", order, original[1], current[1]);
const sparse = [1];
sparse[3] = 4;
console.log("grow", sparse.length);
function holes(source: any): void {
  for (const item of source) console.log("hole", String(item));
}
holes(sparse);
