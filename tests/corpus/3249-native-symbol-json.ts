// @rust-only
// @no-engine
const symbol = Symbol('native');
function erase(input: symbol): unknown { return input; }
const value = erase(symbol);
const object: unknown = { value, kept: 1 };
const array: unknown = [value, 1];
console.log('object', JSON.stringify(object));
console.log('array', JSON.stringify(array));
console.log('identity-object', JSON.stringify(object, (_key: string, item: unknown) => item));
console.log('identity-array', JSON.stringify(array, (_key: string, item: unknown) => item));
console.log('replace-object', JSON.stringify(object, (key: string, item: unknown) => key === 'kept' ? value : item));
console.log('replace-array', JSON.stringify(array, (key: string, item: unknown) => key === '1' ? value : item));
console.log('root-converted', JSON.stringify(value, (_key: string, item: unknown) => typeof item === 'symbol' ? String(item) : item));
