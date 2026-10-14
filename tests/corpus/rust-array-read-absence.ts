// @no-engine
const numbers: number[] = [];
function observe(index: number): void {
  console.log(index, `${numbers[index]}`, numbers[index] + 2);
}
observe(-1); observe(0.5); observe(NaN); observe(Infinity); observe(4294967295);
numbers[-1] = 12;
console.log("property", numbers[-1], numbers.length);

const values = [3];
let reads = 0;
function index(): number { reads++; values.pop(); return 0; }
console.log("order", values[index()], reads, values.length);

function first(values: number[]): number { return values[0]; }
function inspect(value: number): void { console.log("argument", typeof value, value, value + 2); }
const firstAlias = first;
const inspectAlias = inspect;
inspectAlias(firstAlias([]));
inspectAlias(firstAlias([4]));

const flags: boolean[] = [];
const records: { name: string }[] = [];
console.log("types", `${flags[0]}`, `${records[0]}`, flags[0] === undefined, records[0] === undefined);
const names: string[] = [];
const missing = names[0];
console.log("strings", `${missing}`, names[0] + names[1], names[0] + 2, 2 + names[0]);
