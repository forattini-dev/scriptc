// @rust-only
// @no-engine
export {};
const f32 = new Float32Array([0.1, 16777217, -0, 1 / 0, Number('bad')]);
const f64 = new Float64Array([0.1, 16777217, -0]);
console.log('sizes', f32.length, f32.byteLength, f64.length, f64.byteLength);
console.log('rounding', f32[0], f32[1], 1 / f32[2], f32[3], f32[4]);
console.log('double', f64[0], f64[1], 1 / f64[2]);
const copy = new Float32Array(f32);
f32[0] = 2;
console.log('copy', copy[0], f32[0], copy === f32);
const converted = new Float64Array(copy);
const bytes = new Uint8Array(new Float32Array([257.9, -1, Number('bad')]));
console.log('conversion', converted[0], bytes.join(':'));
console.log('empty', new Float32Array().length, new Float64Array(2.9).join(','));
