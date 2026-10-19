// @rust-only
// @no-engine
const values = new Set<unknown>();
const record = { id: 4 }; const callback = () => 7; const symbol = Symbol("value");
values.add(0 / 0); values.add(0 / 0); values.add(-0); values.add(0);
values.add(1); values.add(true); values.add("1"); values.add(undefined); values.add(null);
values.add(record); values.add(record); values.add({ id: 4 });
values.add(callback); values.add(callback); values.add(() => 7); values.add(symbol);
console.log("mixed", values.size, values.has(0 / 0), values.has(-0), values.has(true), values.has(undefined), values.has(null));
console.log("objects", values.has(record), values.has({ id: 4 }), values.has(callback), values.has(() => 7), values.has(symbol));
console.log("nan deletion", values.delete(0 / 0), values.delete(0 / 0), values.size);
values.add(0 / 0); console.log("nan readd", values.has(0 / 0), values.size);
console.log("zero", values.delete(-0), values.has(0), values.delete(0));
values.clear(); console.log("cleared", values.size, values.has(record));
