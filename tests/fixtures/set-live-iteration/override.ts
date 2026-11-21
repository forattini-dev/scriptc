const values = new Set([1, 2]);
(values as any).values = () => [9];
for (const value of values.values()) console.log(value);
