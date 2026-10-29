const values = [3, 1, 2, 1];
const alias = values;
let calls = 0;
const sorted = values.sort((a, b) => { calls++; return a - b; });
console.log("numbers", sorted.join(","), sorted === alias, calls > 0);
const records = [{ key: 2, label: "a" }, { key: 1, label: "b" }, { key: 2, label: "c" }];
records.sort((a, b) => a.key - b.key);
console.log("stable", records[0].label, records[1].label, records[2].label);
const sparse: any[] = [3, 2, 1];
delete sparse[1];
sparse.length = 5;
sparse.sort((a, b) => Number(a) - Number(b));
console.log("sparse", sparse.length, Number(sparse[0]), Number(sparse[1]), sparse[2] === undefined, sparse[4] === undefined);
const unchanged = [3, 2, 1];
unchanged.sort(() => NaN);
console.log("equal", unchanged.join(","));
const mutated = [3, 1, 2];
let first = true;
mutated.sort((a, b) => { if (first) { first = false; mutated[0] = 99; } return a - b; });
console.log("mutated", mutated.join(","));
const failed = [2, 1];
try { failed.sort((_a, _b) => { throw new Error("compare"); }); }
catch (error) { console.log("throw", (error as Error).message, failed.join(",")); }
