// @no-engine
// TypedArray.set from tuples, number[] values and array literals converts each
// element with the destination's own store rule (the typed-array kinds the Rust
// lane supports).
const values: number[] = [0, 0.5, 1.5, 2.5, 255.5, 256, -1, -129, 65535, 65536, 2 ** 31, 2 ** 32 + 5, NaN, Infinity, -Infinity, -0, 1e21, 16777217];

function line(name: string, parts: string[]): void {
  console.log(name, parts.join(" "));
}
function showU8(name: string, view: Uint8Array): void {
  const parts: string[] = [];
  for (let i = 0; i < view.length; i++) parts.push(String(view[i]));
  line(name, parts);
}
function showI32(name: string, view: Int32Array): void {
  const parts: string[] = [];
  for (let i = 0; i < view.length; i++) parts.push(String(view[i]));
  line(name, parts);
}
function showU32(name: string, view: Uint32Array): void {
  const parts: string[] = [];
  for (let i = 0; i < view.length; i++) parts.push(String(view[i]));
  line(name, parts);
}
function showF32(name: string, view: Float32Array): void {
  const parts: string[] = [];
  for (let i = 0; i < view.length; i++) parts.push(Object.is(view[i], -0) ? "-0" : String(view[i]));
  line(name, parts);
}
function showF64(name: string, view: Float64Array): void {
  const parts: string[] = [];
  for (let i = 0; i < view.length; i++) parts.push(Object.is(view[i], -0) ? "-0" : String(view[i]));
  line(name, parts);
}

const u8 = new Uint8Array(values.length);
u8.set(values);
showU8("u8", u8);
const i32 = new Int32Array(values.length);
i32.set(values);
showI32("i32", i32);
const u32 = new Uint32Array(values.length);
u32.set(values);
showU32("u32", u32);
const f32 = new Float32Array(values.length);
f32.set(values);
showF32("f32", f32);
const f64 = new Float64Array(values.length);
f64.set(values);
showF64("f64", f64);

const pair = [3, 4] as const;
const grid = new Uint8Array(6);
grid.set(pair, 4);
grid.set([1, 2], 0);
const readonlyValues: readonly number[] = [9, 8];
grid.set(readonlyValues, 2);
showU8("grid", grid);

const wide = new Int32Array(4);
wide.set([0x12345678, -5] as const, 1);
showI32("wide", wide);

const buffer = Buffer.alloc(6);
buffer.set([104, 105] as const, 1);
buffer.set([33], 5);
console.log(buffer.toString("hex"));

const view = new Uint8Array(8).subarray(2, 6);
view.set([7, 7, 7] as const, 1);
showU8("view", view);

function tooLong(): void {
  try {
    new Uint8Array(3).set([1, 2, 3, 4]);
  } catch (error) {
    console.log("length", error instanceof RangeError, (error as Error).message);
  }
  try {
    new Uint8Array(3).set([1, 2] as const, 2);
  } catch (error) {
    console.log("offset", error instanceof RangeError, (error as Error).message);
  }
  try {
    new Uint8Array(3).set([1] as const, -1);
  } catch (error) {
    console.log("negative", error instanceof RangeError, (error as Error).message);
  }
}
tooLong();

let order = "";
const target = new Uint8Array(4);
function destination(): Uint8Array { order += "d"; return target; }
function source(): readonly [number, number] { order += "s"; return [5, 6]; }
function offset(): number { order += "o"; return 1; }
destination().set(source(), offset());
console.log(order, target.join(","));
