// @rust-only
console.log(Array.from([1, 2, 3]).join(","));
console.log(Array.from([1, 2], (value, index) => value + index).join(","));
console.log(Array.from("a😀🦀", (value, index) => value + index).join(","));
console.log(Array.from("a😀🦀").join(","));
const empty: number[] = [];
console.log(Array.from(empty).length, Array.from(new Map<string, number>()).length);
const source = new Set([1, 2]);
console.log(Array.from(source, () => "x").join(","));
console.log([...new Set(new Map<string, number>([["a", 1], ["b", 2]]).keys())].join(","));
const map = new Map<string, number>([["a", 1], ["b", 2]]);
console.log(Array.from(map, ([key, value], index) => {
  if (index === 0) { map.clear(); map.set("c", 3); }
  return key + value + index;
}).join(","));
console.log(Array.from(source, (value) => Array.from(source).join("") + value).join(","));
try {
  Array.from(map.values(), () => { throw new Error("stop"); return 0; });
} catch (error) { console.log(error instanceof Error); }
map.clear();
map.set("after", 42);
console.log(Array.from(map.values()).join(","));
const short = [1, 2, 3];
console.log(Array.from(short, (value, index) => { if (index === 0) short.pop(); return value; }).join(","));
function custom(): string {
  const Array = { from: (values: number[]): string => "custom " + values.length };
  return Array.from([1, 2]);
}
console.log(custom());
