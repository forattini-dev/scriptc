// @rust-only
// @no-engine
export {};
type Item = { name: string };
const one: Item = { name: "one" };
const two: Item = { name: "two" };
const source = new Set<Item>();
source.add(one); source.add(two); source.add(one);
const copy: Item[] = [...source];
one.name = "changed";
console.log(copy.length, copy[0] === one, copy[1] === two, copy[0].name);
