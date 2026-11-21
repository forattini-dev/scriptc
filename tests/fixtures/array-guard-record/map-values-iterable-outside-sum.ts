function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
const map = new Map<string, any>([['first', '8'], ['second', 2]]);
const result = sum(map.values());
console.log(typeof result, result);
