// @rust-only
// @no-engine
const first = Symbol('same');
const second = Symbol('same');
function erase(value: symbol): unknown { return value; }
const value = erase(first);
console.log('kind', typeof value, typeof value === 'symbol', typeof value !== 'symbol');
console.log('identity', value === first, value === second, value === erase(first));
if (typeof value === 'symbol') console.log('narrow', value === first, value.description);
console.log('cast', (value as symbol) === first);

function either(flag: boolean): string | symbol { return flag ? first : 'text'; }
function echo(input: string | symbol): string | symbol { return input; }
const boxed: unknown = echo;
const callback = boxed as (input: string | symbol) => string | symbol;
console.log('union', callback(either(true)) === first, callback(either(false)) === 'text');
const object = { token: first };
const stored: unknown = object;
const view = stored as { token: symbol };
console.log('record', view.token === first);
object.token = second;
console.log('live', view.token === second);
