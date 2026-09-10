/// <reference types="node" />
// @no-engine
const nested: number[] = [1];
const reader = ReadableStream.from([nested, nested]).getReader();
const first = await reader.read();
if (!first.done) {
  first.value.push(2);
  console.log("first", first.value === nested, nested.length);
}
nested.push(3);
const second = await reader.read();
if (!first.done && !second.done) {
  console.log("second", first.value === second.value, first.value.length, second.value.length);
  second.value.reverse();
  console.log("reverse", JSON.stringify(nested));
  first.value.splice(1, 1);
  console.log("splice", JSON.stringify(second.value), JSON.stringify(nested));
}
console.log("end", (await reader.read()).done);

// Keep the chunks dynamic so operations exercise the projected view itself.
const values: number[] = [4, 5];
const dynamicReader = ReadableStream.from<unknown>([values, values]).getReader();
const dynamicFirst = (await dynamicReader.read()).value;
const dynamicSecond = (await dynamicReader.read()).value;
console.log("dynamic identity", dynamicFirst === dynamicSecond);
if (Array.isArray(dynamicFirst)) {
  dynamicFirst.push(6);
  dynamicFirst[0] = 9;
  console.log("dynamic write", JSON.stringify(values), JSON.stringify(dynamicFirst));
  values[1] = 8;
  console.log("typed write", JSON.stringify(dynamicFirst));
}
