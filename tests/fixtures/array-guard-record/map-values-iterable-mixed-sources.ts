function add(values: Iterable<number>): number { let total = 0; for (const value of values) total += value; return total; }
function* generate(): Generator<number, void, undefined> { yield 4; yield 5; }
console.log(add(new Map<string, number>([['a', 1], ['b', 2]]).values()));
console.log(add([2, 3]));
console.log(add(generate()));
