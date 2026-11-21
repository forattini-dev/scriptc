function sum(values: Iterable<number>): number { let total = 0; for (const value of values) total += value; return total; }
const values: any = [1, 2];
values[Symbol.iterator] = function* () { yield 9; };
console.log(sum(values));
