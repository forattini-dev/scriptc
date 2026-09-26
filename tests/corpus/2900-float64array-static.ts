// Float64Array keeps double precision across construction, element access,
// copies, views, DataView aliases, and typed-array methods.
const a = new Float64Array(4);
console.log("empty", a.length, a.byteLength, a.byteOffset, a[0], a[3]);
a[0] = 0.1;
a[1] = -0.25;
a[2] = 1e100;
a[3] = -0;
console.log("elements", a[0], a[1], a[2], 1 / a[3]);

const seeded = new Float64Array([Math.PI, 0.1, -1.5]);
console.log("seeded", seeded.length, seeded.byteLength, seeded[0], seeded[1], seeded[2]);
const values = [0.2, -3.25];
const fromArray = new Float64Array(values);
console.log("from-array", fromArray[0], fromArray[1]);
const copy = new Float64Array(seeded);
copy[0] = 12.5;
console.log("copy", seeded[0], copy[0]);

const bufferBacked = new Float64Array(new ArrayBuffer(16));
bufferBacked[1] = 3.25;
console.log("buffer", bufferBacked.length, bufferBacked.byteLength, bufferBacked[0], bufferBacked[1]);
const view = new DataView(bufferBacked.buffer);
view.setFloat64(0, -7.5, true);
console.log("dataview", bufferBacked[0], view.getFloat64(8, true));
const alias = Buffer.from(bufferBacked.buffer);
alias.writeDoubleLE(4.5, 8);
console.log("buffer-alias", alias.length, bufferBacked[1]);

const sub = a.subarray(1, 3);
sub[0] = 6.75;
console.log("subarray", a[1], sub[0], sub.length, sub.byteLength, sub.byteOffset);
const slice = a.slice(1, 3);
slice[0] = 9.5;
console.log("slice", a[1], slice[0], slice.byteLength);

const filled = new Float64Array(4);
filled.fill(0.1, 1, 3);
filled.set(new Float64Array([5.5, 6.25]), 2);
console.log("fill-set", filled[0], filled[1], filled[2], filled[3]);
filled.subarray(0, 2).fill(-2.5);
console.log("fill-view", filled[0], filled[1]);

const odd = new Float64Array([0 / 0, 1 / 0, -1 / 0, -0]);
console.log("special", odd[0] !== odd[0], odd[1], odd[2], 1 / odd[3]);
console.log("lengths", new Float64Array().length, new Float64Array(3.5).length, new Float64Array(0 / 0).length);

function doubleFirst(xs: Float64Array): Float64Array {
  const result = new Float64Array(xs);
  result[0] = xs[0] * 2;
  return result;
}
const doubled = doubleFirst(seeded);
console.log("typed", doubled[0], seeded[0]);

const looped = new Float64Array(4);
let sum = 0;
for (let i = 0; i < looped.length; i++) {
  looped[i] = i + 0.125;
  sum += looped[i];
}
console.log("loop", sum, looped[0], looped[3]);

try {
  new Float64Array(-1);
  console.log("bad-length", "ok");
} catch (e) {
  if (e instanceof RangeError) console.log("bad-length", e.name, e.message);
  else console.log("bad-length", "unexpected");
}
