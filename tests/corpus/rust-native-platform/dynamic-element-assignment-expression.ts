// @rust-only
// @no-engine
const target: any = {};
const symbol = Symbol('key');
const key: any = symbol;
const payload: any = { field: 'original' };
let order = '';
function receiver(): any { order += 'r'; return target; }
function property(): any { order += 'k'; return key; }
function value(): any { order += 'v'; return payload; }
const result: any = (receiver()[property()] = value());
console.log('order and identity', order, result === payload, target[symbol] === payload);
function set(object: any, name: any, entry: any): any { return object[name] = entry; }
const count: number = set(target, 'count', 42);
const word: string = set(target, 3, 'three');
console.log('return', count, target.count as number);
console.log('number key', word, target['3'] as string);
const nil: any = null;
order = '';
try { const ignored: any = (nil[property()] = value()); console.log(ignored === payload); } catch (error: any) { console.log('null', order, error instanceof TypeError); }
