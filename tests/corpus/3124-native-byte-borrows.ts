import { Buffer } from "node:buffer";

function arithmetic(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] + data[data.length - i - 1];
  let index = 0;
  sum += data[index++] + data[++index];
  const indices = new Uint8Array([2, 0]);
  index = 0;
  sum += data[indices[index++]];
  return sum + index + data.byteLength;
}
console.log("arithmetic", arithmetic(new Uint8Array([3, 5, 7])));

function directSnapshot(): void {
  // No closure captures this binding: it must stay unboxed, so the index
  // assignment itself is what prevents borrowing the receiver.
  let data = new Uint8Array([11, 12]);
  const first = data[(data = new Uint8Array([21, 22]), 0)];
  console.log("direct", first, data[0]);
}
directSnapshot();

function snapshots(): void {
  let data = new Uint8Array([21, 22]);
  function replace(): number { data = new Uint8Array([31, 32]); return 1; }
  console.log("callback", data[replace()], data[1]);
  const alias = data.subarray(1);
  function mutateAlias(): number { alias[0] = 44; return 1; }
  console.log("alias", data[mutateAlias()], alias[0]);
  const read = (): number => data[0];
  data = new Uint8Array([51]);
  console.log("closure", read());
}
snapshots();

function replaceEachRead(): number {
  let data = new Uint8Array([1, 2, 3]);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    if (i === 1) data = new Uint8Array([4, 5, 6]);
    sum += data[i];
  }
  return sum;
}
console.log("reassign", replaceEachRead());

function views(): void {
  const data = Buffer.from([10, 20, 30, 40]);
  const view = data.subarray(1, 3);
  console.log("view", view[0], view[1], view.length, view.byteLength);
  data[1] = 99;
  console.log("view changed", view[0]);
  const floats = new Float64Array([1.5, -0, 2.25]);
  for (let i = 0; i < floats.length; i++) console.log("float", floats[i], Object.is(floats[i], -0));
}
views();

async function suspension(): Promise<void> {
  let data = new Uint8Array([61, 62]);
  async function replace(): Promise<number> {
    await Promise.resolve();
    data = new Uint8Array([71, 72]);
    return 0;
  }
  console.log("await snapshot", data[await replace()], data[0]);
  console.log("after await", data[0]);
}
await suspension();

function* suspendedReads(data: Uint8Array): Generator<number> {
  for (let i = 0; i < data.length; i++) yield data[i];
}
const generatorData = new Uint8Array([81, 82]);
const iterator = suspendedReads(generatorData);
console.log("generator", iterator.next().value);
generatorData[1] = 91;
console.log("generator changed", iterator.next().value);
console.log("generator done", iterator.next().done);
