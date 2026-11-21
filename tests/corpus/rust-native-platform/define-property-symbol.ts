// @rust-only
// @no-engine
const key = Symbol('property');
const other = Symbol('property');
const target: any = { text: 'original' };
const alias: any = target;
let order = '';
function object(): any { order += 'o'; return target; }
function symbol(): symbol { order += 'k'; return key; }
function value(): string { order += 'v'; return 'first'; }
const result: any = Object.defineProperty(object(), symbol(), {
  value: value(), writable: true, enumerable: true, configurable: true,
});
console.log('identity and order', result === alias, order, alias[key] as string);
console.log('distinct', key in alias, other in alias, Object.keys(alias).join(','));
Object.defineProperty(alias, key, {
  value: 'second', writable: true, enumerable: true, configurable: true,
});
console.log('redefined', target[key] as string);
const copy: any = { ...alias };
console.log('copied', copy[key] as string, other in copy);
const typed = { text: 'typed' };
Object.defineProperty(typed, key, {
  value: 'typed symbol', writable: true, enumerable: true, configurable: true,
});
const erased: any = typed;
console.log('typed', erased[key] as string, key in erased);
