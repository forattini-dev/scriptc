function sum(values: Iterable<number>): number { let total = 0; for (const value of values) total += value; return total; }
console.log(sum(new Map<string, number>([['a', 2], ['b', 3]]).values()));
