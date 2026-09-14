// @no-engine
let calls = 0;
function next(): string { calls++; return "value"; }
console.log(next() == null, calls);
console.log(undefined != next(), calls);
function fail(): string { throw new Error("observed"); }
try { console.log(fail() == undefined); } catch { console.log("caught"); }
const values: string[] = ["x"];
let index = 0;
console.log(values[index++] == undefined, index);
function union(): string | number { calls++; return calls % 2 === 0 ? "x" : 1; }
console.log(union() == undefined, calls);
class Readable {
  get value(): string { calls++; return "x"; }
}
console.log(new Readable().value != undefined, calls);
