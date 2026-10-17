// @rust-only
// @no-engine
export {};
function same(a: symbol, b: symbol): boolean { return a === b; }
const a = Symbol.for('shared');
const b = Symbol.for('shared');
const fresh = Symbol('shared');
console.log('registry', same(a, b), same(a, fresh), Symbol.keyFor(a) === 'shared', Symbol.keyFor(fresh) === undefined);
const anonymous = Symbol();
const explicit = Symbol(undefined);
const empty = Symbol('');
console.log('description', a.description === 'shared', anonymous.description === undefined, explicit.description === undefined, empty.description === '');
let calls = 0;
function description(): string { calls = calls + 1; console.log('description effect'); return 'effect'; }
console.log('ordered', Symbol(description()).toString(), calls);
function shadow(Symbol: (key: string) => string): string { return Symbol('shadow'); }
function literal(value: string): string { return value; }
console.log('shadow', shadow(literal));
