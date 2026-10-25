// @rust-only
// @no-engine
function keys(value: unknown): string { return Object.keys(value as object).join('|'); }
console.log('primitives', keys(42), keys(false), keys(Symbol('key')));
console.log('strings', keys('A😀Z'), keys('😀'.charAt(0) + 'x'), keys(''));
console.log('arrays', keys([1, undefined, 3]), keys([]));
console.log(Object.keys([true, false]).join('|'));
console.log(Object.keys(new Uint8Array([4, 8])).join('|'));
console.log(Object.keys(['left', 2] as const).join('|'));
const dictionary: Record<string, number | undefined> = {};
dictionary.z = 1;
dictionary['10'] = 2;
dictionary['2'] = 3;
dictionary['01'] = 4;
dictionary['4294967295'] = 5;
dictionary['4294967294'] = 6;
dictionary['-0'] = undefined;
dictionary.z = 7;
console.log('dictionary', Object.keys(dictionary).join('|'), keys(dictionary));
const numeric: Record<number, string> = {};
numeric[10] = 'ten'; numeric[2] = 'two'; numeric[-1] = 'negative';
console.log(Object.keys(numeric).join('|'));
const data: { a?: number; b: number | undefined } = { b: undefined };
console.log(keys(data)); data.a = 1; console.log(keys(data));
const first = Object.keys(data); first.push('extra'); console.log(keys(data));
const other: { b: number | undefined; a: number } = { b: undefined, a: 1 };
console.log('records', keys(other), keys({ constructor: 1 }));
export {};
