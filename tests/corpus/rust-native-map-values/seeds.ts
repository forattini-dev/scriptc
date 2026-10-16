// @rust-only
// @no-engine
function effect(label: string, value: unknown): unknown { console.log("seed", label); return value; }
const nan = 0 / 0;
const key = { value: 1 };
const other = { value: 1 };
const map = new Map<any, any>([
  [effect("first-key", nan), effect("first-value", "first")],
  [effect("second-key", nan), effect("second-value", "replaced")],
  [effect("zero-key", -0), effect("zero-value", "zero")],
  [key, "object"],
  ["1", "string"],
  [1, "number"],
]);
console.log(map.size, map.get(nan) === "replaced", map.get(0) === "zero", map.get(key) === "object", map.get(other) === undefined);
console.log(map.get("1") === "string", map.get(1) === "number");
map.set(nan, "written");
console.log(map.get(nan) === "written", map.size, map.delete(nan), map.has(nan));
map.clear();
console.log(map.size);
