// @rust-only
// @no-engine
export {};
const values = new Float32Array([1, 2, 3, 4]);
const view = values.subarray(1, 3);
const copy = values.slice(1, 3);
view[0] = 9;
console.log('owners', values.join(','), view.join(':'), copy.join(','));
console.log('widths', view.length, view.byteLength, copy.byteLength);
values.set(values.subarray(0, 3), 1);
console.log('overlap', values.join(','));
const doubles = new Float64Array([1, 2, 3]);
doubles.subarray(1)[0] += 0.25;
console.log('double', doubles.slice(-2).join(','), doubles.byteLength);
