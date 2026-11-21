// @rust-only
// @no-engine
const object: any = { initial: 'keep' };
const symbol = Symbol('key');
const descriptor: any = { value: 'first', writable: true, enumerable: true, configurable: true };
let order = '';
function target(): any { order += 't'; return object; }
function key(): any { order += 'k'; return 'field'; }
function attributes(): any { order += 'd'; return descriptor; }
const result: any = Object.defineProperty(target(), key(), attributes());
console.log('define', result === object, order, object.field as string, Object.keys(object).join(','));
descriptor.value = 'second';
const another: any = symbol;
Object.defineProperty(object, another, descriptor);
console.log('symbol', object[symbol] as string, symbol in object);
descriptor.value = undefined;
Object.defineProperty(object, another, descriptor);
console.log('undefined', object[symbol] === undefined, symbol in object);
const copy: any = { ...object };
console.log('copy', copy.field as string, symbol in copy);
