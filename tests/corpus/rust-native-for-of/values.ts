// @rust-only
// @no-engine
export {};
let text = "";
for (const value of [1, 2, 3]) text = text + value;
console.log("numbers", text);
const rows = [{value: 1}, {value: 2}];
for (const row of rows) row.value = row.value + 10;
console.log("records", rows[0].value, rows[1].value);
const readonly: readonly string[] = ["a", "b"];
for (const value of readonly) console.log("readonly", value);
const tuple: [string, number, boolean] = ["x", 2, false];
for (const value of tuple) console.log("tuple", value);
const twelve = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
for (const value of twelve) { if (value > 9) console.log("tail", value); }
const mutable: [number, number] = [1, 2];
for (const value of mutable) { mutable[1] = 8; console.log("tuple-live", value); }
function sum(values: number[]): number { let total = 0; for (const value of values) total = total + value; return total; }
console.log("empty", sum([]));
let value = "outer";
for (const value of ["inner"]) console.log("scope", value);
console.log("scope-after", value);
