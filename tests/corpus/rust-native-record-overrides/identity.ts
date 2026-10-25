// @rust-only
// @no-engine
export {};
const nested = { count: 1 };
const items = ["a"];
const callback = (value: string) => value + "!";
const old = { nested: false, items: 0, callback: "old", label: "copy" };
const copy = { ...old, nested, items, callback };
console.log("identity", copy.nested === nested, copy.items === items, copy.callback === callback, copy.callback("x"));
copy.nested.count = 2;
copy.items.push("b");
old.label = "changed";
console.log("snapshot", nested.count, items.join("|"), copy.label, old.nested, old.items, old.callback);
function make(prefix: string) {
  const base = { read: false };
  return { ...base, read(value: string): string { return prefix + value; } };
}
const method = make("m:");
console.log("method", method.read("x"), method.read === method.read);
const reversed = { ...{ value: callback }, ...{ value: nested } };
console.log("reverse", reversed.value === nested, reversed.value.count);
