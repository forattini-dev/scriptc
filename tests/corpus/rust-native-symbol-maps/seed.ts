export {};
const key = Symbol('key');
const other = Symbol('key');
const entries: [symbol, string][] = [[key, 'first'], [other, 'other'], [key, 'last']];
const writable = new Map<symbol, string>(entries);
const readonly: ReadonlyMap<symbol, string> = writable;
console.log('seed', readonly.size, readonly.get(key), readonly.get(other));
writable.delete(key);
console.log('alias', readonly.has(key), readonly.has(other), readonly.size);
