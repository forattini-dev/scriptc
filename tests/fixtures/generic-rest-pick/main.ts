function pick<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}
const object = { value: 7 };
const symbol = Symbol('entry');
const func = (value: number): number => value + 1;
let calls = 0;
function next<T>(value: T): T { calls++; return value; }
console.log('values', pick<number>(), pick(undefined, 0, 3), pick(undefined, false), pick(undefined, 'text'), pick(undefined, null));
console.log('identity', pick(undefined, object) === object, pick(...[undefined, object]) === object);
console.log('other identity', pick(undefined, symbol) === symbol, pick(undefined, func) === func);
const sparse: Array<number | undefined> = [];
sparse.length = 2;
sparse[1] = 9;
console.log('sparse', pick(...sparse));
console.log('order', pick(next(undefined), next(1), next(2)), calls);
