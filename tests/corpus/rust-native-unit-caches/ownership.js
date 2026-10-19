// @rust-only
// @no-engine
export {};
function cell() {
  let value = null;
  const read = () => value;
  const write = next => { value = next; };
  return { read, write };
}
const first = cell();
const second = cell();
console.log("fresh", first.read() === null, second.read() === null);
const record = { count: 7 };
first.write(record);
const snapshot = first.read();
console.log("record", snapshot === record, second.read() === null);
first.write(null);
console.log("snapshot", snapshot === record, first.read() === null);
const array = ["one"];
second.write(array);
console.log("array", second.read() === array);
const callback = () => 9;
first.write(callback);
console.log("callback", first.read() === callback);
first.write(undefined);
second.write(null);
console.log("reset", first.read() === undefined, second.read() === null);
const cycle = { read: first.read };
first.write(cycle);
console.log("owning cycle", first.read() === cycle);
