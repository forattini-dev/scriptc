const values = new Set([1, 2]);
(values as any)[Symbol.iterator] = () => [9][Symbol.iterator]();
for (const value of values) console.log(value);
