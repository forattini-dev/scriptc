/// <reference types="node" />
// @no-engine
const bytes = new Uint8Array([1]);
const reader = ReadableStream.from([bytes, bytes]).getReader();
const first = await reader.read();
if (!first.done) {
  first.value[0] = 7;
  console.log("first", first.value === bytes, bytes[0]);
}
bytes[0] = 9;
const second = await reader.read();
if (!first.done && !second.done) {
  console.log("second", first.value === second.value, first.value[0], second.value[0]);
}
console.log("end", (await reader.read()).done);
