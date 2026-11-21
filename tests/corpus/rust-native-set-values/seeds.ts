// @rust-only
// @no-engine
type Item = { id: number };
const item = { id: 1 }; const other = { id: 1 }; const array = [item, item, other];
function seed(): Item[] { console.log("seed once"); return array; }
const records = new Set(seed()); array.push({ id: 3 }); item.id = 7;
console.log("seed records", records.size, records.has(item), records.has({ id: 7 }), item.id);
const fn = () => 3; const symbol = Symbol("seed");
const mixed = new Set<unknown>([0 / 0, 0 / 0, -0, 0, true, undefined, null, item, item, fn, fn, symbol]);
console.log("mixed seed", mixed.size, mixed.has(0 / 0), mixed.has(0), mixed.has(fn), mixed.has(item), mixed.has(symbol));
console.log("null seeds", new Set<unknown>(null).size, new Set<unknown>(undefined).size, new Set<unknown>([]).size);
const onlyUndefined = new Set([undefined]);
console.log("undefined element", onlyUndefined.size, onlyUndefined.has(undefined));
