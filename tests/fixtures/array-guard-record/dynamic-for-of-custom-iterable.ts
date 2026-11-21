class Numbers { *[Symbol.iterator](): Generator<number, void, undefined> { yield 4; yield 5; } }
function consume(values: any): number { let total = 0; for (const value of values) total += value; return total; }
console.log(consume(new Numbers()));
