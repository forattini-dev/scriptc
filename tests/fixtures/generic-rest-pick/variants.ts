function firstOr<T>(fallback: T, ...values: T[]): T {
  return values.length ? values[0] : fallback;
}
function list<T>(...values: T[]): T[] { return values; }
function sum<T extends { n: number }>(...values: T[]): number {
  let total = 0;
  for (const value of values) total += value.n;
  return total;
}
const object = { n: 8 };
const other = { n: 3, label: 'x' };
console.log('first', firstOr(9), firstOr(9, 3), firstOr('none', 'a', 'b'));
console.log('identity', firstOr(object, object) === object, list(object, object)[0] === object);
console.log('sum', sum(object, other), sum({ n: 2 }, { n: 4 }));
console.log('empty', list<number>().length, list('a', 'b').join(','));
