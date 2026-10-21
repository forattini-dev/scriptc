// @rust-only
// @no-engine
export {};
const key: symbol = Symbol.asyncIterator;
function same(a: symbol, b: symbol): boolean { return a === b; }
class Box {
  value: symbol;
  constructor(value: symbol) { this.value = value; }
}
const values: symbol[] = [key, Symbol.iterator];
const record = { value: key };
const box = new Box(key);
function capture(value: symbol): () => symbol { return () => value; }
const read = capture(key);
console.log('storage', same(values[0], record.value), same(box.value, read()), same(read(), key));
const erased: any = key;
console.log('erased', typeof erased, erased === key, erased === Symbol.for('Symbol.asyncIterator'));
let optional: symbol | undefined = key;
console.log('optional', optional === key);
optional = undefined;
console.log('empty', optional === undefined);
try { throw key; } catch (error) { console.log('caught', error === key, typeof error); }
