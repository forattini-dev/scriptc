// @rust-only
// @no-engine
export {};
function same(a: symbol, b: symbol): boolean { return a === b; }
function reader(value: symbol): () => symbol { return () => value; }
const first = Symbol('first');
const second = Symbol('second');
const values: symbol[] = [first, second];
const record = { token: first };
const read = reader(record.token);
console.log('storage', same(values[0], read()), !same(values[1], record.token));
class Box { token: symbol; constructor(value: symbol) { this.token = value; } get(): symbol { return this.token; } }
const box = new Box(second);
console.log('class', same(box.get(), second));
function maybe(yes: boolean): symbol | undefined { if (yes) return first; return undefined; }
const present = maybe(true);
if (present !== undefined) console.log('optional', same(present, first));
console.log('absent', maybe(false) === undefined);
