const key = Symbol('item');
const other = Symbol('item');
const object: unknown = { item: 17, 'Symbol(item)': 23 };
function read(value: any, name: symbol): unknown { return value[name]; }
console.log('missing', read(object, key) === undefined, read(object, other) === undefined);
console.log('well-known', read(object, Symbol.iterator) === undefined);
let order = '';
function receiver(): any { order += 'r'; return object; }
function property(): symbol { order += 'k'; return key; }
console.log('evaluation', receiver()[property()] === undefined, order);
try { read(null, key); } catch (error) { console.log('null', error instanceof TypeError, (error as Error).message); }
try { read(undefined, key); } catch (error) { console.log('undefined', error instanceof TypeError, (error as Error).message); }
