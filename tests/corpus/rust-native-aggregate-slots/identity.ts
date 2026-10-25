// @ts-nocheck
// @rust-only
// @no-engine
let escaped: any = undefined;
function capture<T>(factory: () => T): T {
  const value = factory();
  escaped = value;
  return value;
}
const result = capture(() => ({ key: undefined, children: [], count: 0 }));
const original = escaped;
console.log("same store", original === result, result === original);
original.count = 1;
result.count = result.count + 1;
original.key = "changed";
console.log("shared writes", original.count === 2, result.count === 2, result.key === "changed");
const map = new Map<object, string>();
map.set(original, "stored");
console.log("map identity", map.has(result), map.get(result) === "stored");
const weak = new WeakMap<object, string>();
weak.set(original, "weak");
console.log("weak identity", weak.has(result), weak.get(result) === "weak");
original.self = result;
console.log("extra key", Object.keys(result).join(",").includes("self"));
try { JSON.stringify(original); }
catch (error) { console.log("cycle", error instanceof TypeError); }
