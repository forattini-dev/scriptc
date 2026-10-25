// @rust-only
// @no-engine
const value = 9007199254740993n;
const array: bigint[] = [value, value + 1n];
const alias = array;
alias.push(value + 10n);
console.log("array", array[0], array[1], array.pop(), array.pop(), array.pop());
const record = { value };
const same = record;
same.value = same.value + 2n;
console.log("record", record.value);
function counter(start: bigint): () => bigint { let value = start; return () => { value = value + 1n; return value; }; }
const next = counter(value);
console.log("capture", next(), next());
const map = new Map<bigint, string>();
map.set(value, "first"); map.set(BigInt("9007199254740993"), "same");
console.log("map", map.size, map.get(value), map.has(value + 1n));
function nullable(value: bigint | undefined): void { console.log("union", value, typeof value); }
nullable(value); nullable(undefined);
function dynamic(value: any): any { return value; }
const boxed = dynamic(record.value);
console.log("boxed", typeof boxed, String(boxed), boxed === record.value);

const set = new Set<bigint>(); set.add(value); set.add(BigInt("9007199254740993")); console.log("set", set.size, set.has(value), set.delete(value), set.size);
try { throw value; } catch (error) { console.log("caught", typeof error, String(error)); }
