// @rust-only
// @no-engine
export {};
type Item = {value: number};
const item: Item = {value: 1};
const source: Item[] = [item];
const copy: Item[] = [...source, item];
copy[0].value = 7;
console.log(source[0].value, item.value, copy[0] === item, copy[1] === item, source === copy);
const set = new Set([item, ...source]);
console.log(set.size, set.has(item), set.has({value: 7}));
const inner: number[] = [1, 2];
const nested: number[][] = [inner];
const shallow = [...nested];
shallow[0].push(3);
console.log(inner.join(","));
console.log(shallow[0] === inner);
const mixed = new Set<unknown>([1, ...[1, 2], "2", ...["2", "3"]]);
console.log(mixed.size, mixed.has(1), mixed.has("2"), mixed.has(2));
const erased: unknown = [0, ...[1, 2], "end"];
console.log(String(JSON.stringify(erased)));
