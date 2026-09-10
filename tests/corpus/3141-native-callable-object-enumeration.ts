// @rust-only
// @no-engine
// C/LLVM explicitly refuse the shared callable-record exit below.
const numbers = [2, 4];
let calls = 0;
function describe(value: string): string { calls++; return `called:${value}`; }
const object = { label: "native", values: numbers, describe, ready: true, count: 7 };
// Force the same shared representation as module namespace enumeration.
const alias: unknown = object;
console.log("keys", Object.keys(object).sort().join(","));
for (const value of Object.values(object)) {
  if (typeof value === "function") console.log("function", value === describe, value("values"));
  else if (typeof value === "string") console.log("string", value);
  else if (typeof value === "boolean") console.log("boolean", value);
  else if (typeof value === "number") console.log("number", value);
  else {
    console.log("array", value === numbers, value.join(","));
    value.push(6);
  }
}
console.log("mutations", numbers.join(","), calls);
for (const [key, value] of Object.entries(object)) {
  if (typeof value === "function") console.log("entry", key, value("entries"));
  else if (typeof value === "object") console.log("entry", key, value === numbers, value.join(","));
  else if (typeof value === "string") console.log("entry", key, value.toUpperCase());
  else if (typeof value === "number") console.log("entry", key, value + 1);
  else if (typeof value === "boolean") console.log("entry", key, value ? "true" : "false");
}
const restored = alias as typeof object;
console.log("restored", restored.describe === describe, restored.values === numbers, calls);
