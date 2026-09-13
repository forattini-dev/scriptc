// @rust-only
const set = new Set(["a", "b", "c"]);
const mapped = Array.from(set, (value, index) => {
  if (value === "a") { set.delete("b"); set.add("d"); }
  return value + index;
});
console.log(mapped.join(","));
const map = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
console.log(Array.from(map.values(), (value, index) => {
  if (value === 1) { map.delete("b"); map.set("c", 30); map.set("d", 4); }
  return value + index;
}).join(","));
const array = [1, 2];
console.log(Array.from(array, (value, index) => {
  if (index === 0) array.push(3);
  return value * 10 + index;
}).join(","));
const tuple: [number, number] = [1, 2];
console.log(Array.from(tuple, (value, index) => {
  if (index === 0) tuple[1] = 20;
  return value;
}).join(","));
let sourceCalls = 0;
let mapperCalls = 0;
function source(): Set<string> { sourceCalls++; return set; }
function mapper(): (value: string) => string {
  mapperCalls++;
  set.add("e");
  return (value: string): string => value;
}
console.log(Array.from(source(), mapper()).join(","), sourceCalls, mapperCalls);
try {
  Array.from(set, (value) => {
    if (value === "c") { set.clear(); set.add("after"); throw new Error("mapper stopped"); }
    return value;
  });
} catch (error) { console.log(error instanceof Error); }
set.add("last");
console.log(Array.from(set).join(","));
