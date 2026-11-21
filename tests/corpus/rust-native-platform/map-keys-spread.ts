// @rust-only
// @no-engine
const values = new Map<string, number>([['first', 1], ['second', 2]]);
values.delete('first');
values.set('first', 3);
let calls = 0;
function receiver(): Map<string, number> { calls++; return values; }
function mutate(): string { values.set('later', 4); return 'end'; }
const keys = ['start', ...receiver().keys(), mutate()];
console.log('order', keys.join(','), calls);
console.log('later', [...values.keys()].join(','));
const empty = new Map<string, number>();
console.log('empty', [...empty.keys()].length);
const nums = new Map<number, string>([[2, 'two'], [1, 'one'], [-0, 'zero']]);
console.log('numeric', [...nums.keys()].join(','));
const readonly: ReadonlyMap<string, number> = values;
console.log('readonly', [...readonly.keys()].join(','));
const firstSymbol = Symbol('same');
const secondSymbol = Symbol('same');
const symbols = new Map<symbol, number>([[firstSymbol, 1], [secondSymbol, 2]]);
const symbolKeys = [...symbols.keys()];
console.log('symbols', symbolKeys.length, symbolKeys[0] === firstSymbol, symbolKeys[1] === secondSymbol);
