// @rust-only
// @no-engine
// @ts-nocheck
const keys = ['a'];
function seed(): string[] | null { return keys; }
const present = seed()[0];
const absent = seed()[9];
const names = new Set<string>(['a', 'undefined', '2']);
console.log('query', names.has(present), names.has(absent), names.has(2), names.has(undefined));
console.log('delete', names.delete(absent), names.has('undefined'), names.size);
console.log('other-tags', names.has(Symbol('a')), names.has({ value: 1 }), names.has(null));
const numbers = new Set<number>([0, 0 / 0]);
console.log('numeric', numbers.has('0'), numbers.has(-0), numbers.has(0 / 0), numbers.delete('0'), numbers.size);
let active = new Set<string>(['a']);
const original = active;
let calls = 0;
function swap(): unknown { calls++; active = new Set<string>([]); return 'a'; }
console.log('receiver', active.has(swap()), calls, original.size, active.size);
const table: Record<string, string> = { a: 'A', undefined: 'missing', null: 'nil', true: 'yes', 2: 'two' };
console.log('property', table[present], table[absent]);
function read(key: string | number | boolean | null | undefined): void { console.log('key', table[key]); }
read(undefined); read(null); read(true); read(2);

let filter: Set<string> | null | undefined = names;
let checks = 0;
function predicate(): boolean { checks++; return true; }
function currentFilter(): Set<string> | null | undefined { return filter; }
console.log('set-and', names && predicate(), checks);
console.log('nullable-set', (currentFilter() && predicate()) === true, checks);
filter = null;
console.log('null-set', (currentFilter() && predicate()) === null, checks);
filter = undefined;
console.log('undefined-set', (currentFilter() && predicate()) === undefined, checks);
filter = names;
const reject = currentFilter() && !names.has(absent);
console.log('filter', reject === true);
