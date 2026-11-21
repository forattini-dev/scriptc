function inspect(values: Iterable<number>): void {
  for (const value of values) console.log(typeof value, String(value));
}
const map = new Map<string, any>([['a', 'outside'], ['b', null], ['c', 3]]);
inspect(map.values());
