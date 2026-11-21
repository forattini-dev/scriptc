function consume(values: Iterable<number>): void { for (const value of values) console.log(value); }
function* source(): Generator<number, void, number> { yield 1; yield 2; }
consume(new Map<string, number>().values());
consume(source() as any);
