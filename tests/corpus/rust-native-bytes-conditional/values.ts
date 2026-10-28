// @rust-only
// @no-engine
const src = new Uint8Array([19]);
const dst = new Uint8Array([7, 8, 9]);
let trace = '';
function index(i: number): number { trace += 'i'; return i; }
function fallback(): number { trace += 'f'; return 261; }
dst[0] = true ? src[index(5)]! : fallback();
dst[1] = false ? src[index(0)]! : fallback();
dst[2] = true ? src[index(0)]! : fallback();
console.log('bytes', dst[0], dst[1], dst[2], trace);
const floats = new Float64Array(1);
floats[0] = true ? src[4]! : 1;
console.log('float-nan', Number.isNaN(floats[0]));

function read(value: Uint8Array | null, i: number): void {
  try { console.log('read', value![index(i)]); }
  catch (error) { if (error instanceof TypeError) console.log('null-read', error.message); }
}
read(src, 0);
read(src, -1);
read(src, 0.5);
read(src, 5);
read(null, 2);
console.log('key-order', trace);

function optional(value: Uint8Array | null, i: number): void {
  console.log('optional', value?.[index(i)] ?? 41);
}
optional(src, 0);
optional(src, 8);
optional(null, 3);
console.log('optional-order', trace);
