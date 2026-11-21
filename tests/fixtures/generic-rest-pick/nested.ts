function invoke<T>(...functions: Array<() => T>): T { return functions[0](); }
function deferred<T>(...values: T[]): () => T { return () => values[0]; }
function list<T>(...values: T[]): T[] { return values; }
const object = { n: 5 };
const numbers = list(1, 2);
const alias = numbers;
numbers.push(3);
console.log('callback', invoke(() => 4), invoke(() => 'ok'), invoke(() => object) === object);
console.log('closure', deferred(7)(), deferred('later')(), deferred(object)() === object);
console.log('aliases', numbers === alias, alias.join(','));
