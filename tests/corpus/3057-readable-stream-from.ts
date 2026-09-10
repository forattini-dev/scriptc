/// <reference types="node" />
// @no-engine
const values = [1, 2];
const stream = ReadableStream.from(values);
await Promise.resolve();
await Promise.resolve();
values[0] = 10;
const reader = stream.getReader();
console.log("first", (await reader.read()).value);
values[1] = 20;
values.push(30);
console.log("second", (await reader.read()).value);
console.log("third", (await reader.read()).value);
console.log("end", (await reader.read()).done, (await reader.read()).done);
reader.releaseLock();
console.log("unlocked", stream.locked);

const bytes = new Uint8Array([1, 2]);
const byteReader = ReadableStream.from(bytes).getReader();
bytes[0] = 5;
console.log("byte", (await byteReader.read()).value);
bytes[1] = 6;
console.log("byte", (await byteReader.read()).value, (await byteReader.read()).done);

const textReader = ReadableStream.from("A😀ç").getReader();
console.log("text", (await textReader.read()).value);
console.log("text", (await textReader.read()).value);
console.log("text", (await textReader.read()).value, (await textReader.read()).done);

const box = { value: 1 };
const boxes = [box];
const objectReader = ReadableStream.from(boxes).getReader();
const item = await objectReader.read();
if (!item.done) {
  item.value.value = 8;
  console.log("identity", item.value === box, box.value);
}
await objectReader.cancel();
console.log("cancelled", (await objectReader.read()).done);
