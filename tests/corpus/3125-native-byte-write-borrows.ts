import { Buffer } from "node:buffer";

function arithmetic(data: Uint8Array): void {
  for (let i = 0; i < data.length; i++) data[i] = data[i] + 3;
  let i = 0;
  data[i++] = data[i++] + i;
  data[++i] = data[0] + 256;
  console.log("arithmetic", data.join(","), i);
}
arithmetic(new Uint8Array([10, 20, 30, 40]));

function directSnapshots(): void {
  // No captures: assignments themselves must reject borrowing an unboxed binding.
  let data = new Uint8Array([1, 2]);
  const first = data;
  data[(data = new Uint8Array([3, 4]), 0)] = data[1] + 10;
  console.log("index snapshot", first.join(","), data.join(","));
  const second = data;
  data[1] = (data = new Uint8Array([5, 6]), 27);
  console.log("value snapshot", second.join(","), data.join(","));
}
directSnapshots();

function aliases(): void {
  const data = Buffer.from([1, 2, 3, 4]);
  const view = data.subarray(1, 3);
  view[1] = data[0] + view[0];
  data[0] = 8;
  view[0] = data[0];
  console.log("view", data.join(","), view.join(","));
  const floats = new Float64Array([1.5, 2.5, 3.5]);
  for (let i = 0; i < floats.length; i++) floats[i] = floats[i] + 0.25;
  floats[0] = -0;
  console.log("floats", floats[0], floats[1], floats[2], Object.is(floats[0], -0));
  const signed = new Int32Array(3);
  signed[0] = 1.5;
  signed[1] = 2.5;
  signed[2] = 2147483648;
  console.log("signed", signed[0], signed[1], signed[2]);
}
aliases();

function callbacks(): void {
  let data = new Uint8Array([1, 2]);
  const first = data;
  function replace(): number { data = new Uint8Array([3, 4]); return 9; }
  data[0] = replace();
  console.log("callback", first.join(","), data.join(","));
  const alias = data.subarray(1);
  function changeAlias(): number { alias[0] = 8; return 7; }
  data[0] = changeAlias();
  console.log("callback alias", data.join(","));
}
callbacks();

async function suspension(): Promise<void> {
  let data = new Uint8Array([1, 2]);
  const first = data;
  async function replace(): Promise<number> {
    await Promise.resolve();
    data = new Uint8Array([3, 4]);
    return 7;
  }
  const value = await replace();
  first[0] = value;
  console.log("await", first.join(","), data.join(","));
}
await suspension();

function* writes(data: Uint8Array): Generator<number, void, number> {
  const value = yield 5;
  data[0] = value;
}
const target = new Uint8Array([1]);
const iterator = writes(target);
console.log("yield", iterator.next(0).value, target[0]);
console.log("done", iterator.next(9).done, target[0]);
