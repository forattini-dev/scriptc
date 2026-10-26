// @rust-only
// @no-engine
export {};
let calls = 0;
let source: unknown[] = [1, 2];
const alias = source;
function values(): unknown[] { calls++; return source; }
for (const value of values()) {
  console.log("live", String(value));
  if (value === 1) { alias.push(3); source = [99]; alias[1] = 8; }
}
console.log("once", calls, String(source[0]), alias.length);
const shrinking = [1, 2, 3];
for (const value of shrinking) { console.log("shorten", value); shrinking.length = 1; }
const sparse: unknown[] = [0, 1, 2];
delete sparse[1];
for (const value of sparse) console.log("sparse", value === undefined, String(value));
const optional: (number | undefined)[] = [0, 1, 2];
optional.length = 5;
for (const value of optional) console.log("optional", value === undefined, String(value));
console.log("indexed-hole", optional[3] === undefined);
const moving: unknown[] = [1, 2, 3];
let position = 0;
for (const value of moving) {
  console.log("delete-live", String(value));
  if (position === 0) delete moving[1];
  position++;
}

const lengths = [1, 2, 3];
for (const invalid of [-1, 1.5, 0 / 0, 1 / 0, 4294967296]) {
  try { lengths.length = invalid; }
  catch (error) { console.log("length-error", error instanceof RangeError, lengths.length); }
}
let lengthCalls = 0;
let target: number[] = [1, 2, 3];
const original = target;
function receiver(): number[] { lengthCalls++; return target; }
function replacement(): number { target = [99]; return 1; }
receiver().length = replacement();
console.log("length-order", lengthCalls, original.length, target.length, target[0]);
