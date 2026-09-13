// @rust-only
const set = new Set(["b", "a"]);
console.log(Array.from(set).join(","));
const values = [1, 2];
const copy = Array.from(values);
copy.push(3);
console.log(values.join(","), copy.join(","));
console.log(Array.from(["a", "b"] as const).join(","));
const map = new Map<string, number>([["b", 2], ["a", 1]]);
console.log(Array.from(map.keys()).join(","));
console.log(Array.from(map.values()).join(","));
for (const [key, value] of Array.from(map)) console.log(key, value);
console.log(Array.from(map.entries(), ([key, value], index) => key + value + index).join(","));
console.log(Array.from(map.values(), (value) => value * 10).join(","));
console.log(Array.from(set.values()).join(","));
console.log(Array.from(set.keys(), (value, index) => value + index).join(","));
console.log(Array.from(set.entries(), ([a, b]) => a + b).join(","));
