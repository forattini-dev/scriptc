// @ts-nocheck
// @rust-only
// @no-engine
export {};
const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
console.log("bytes", chunks.reduce((n, c) => n + c.length, 7));
const empty: number[] = [];
console.log("empty", empty.reduce((a, b) => a + b, 8));
const values: unknown[] = [1, 2, 3, 4];
delete values[1];
let trace = "";
const sum = values.reduce((acc: number, value: unknown, index: number) => {
  trace += String(index);
  if (index === 0) { values[1] = 7; delete values[2]; values.push(100); }
  return acc + Number(value);
}, 0);
console.log("live", sum, trace, values.length);
const shrinking = [1, 2, 3];
const shrink = shrinking.reduce((acc, value, index) => {
  if (index === 0) shrinking.length = 1;
  return acc + Number(value);
}, 0);
console.log("shrink", shrink);




let order = "";
function source(): number[] { order += "s"; return [2, 3]; }
function initial(): number { order += "i"; return 4; }
console.log("order", source().reduce((a, b) => { order += "c"; return a + b; }, initial()), order);
const alias = [2, 3];
console.log("identity", alias.reduce((a, b, i, array) => a + (array === alias ? b : 100), 0));
try { alias.reduce((a, b) => { throw new Error("stop"); return a + b; }, 0); }
catch (error) { if (error instanceof Error) console.log("throw", error.message); }

let ignoredOrder = "";
function ignored(): number { ignoredOrder += "e"; return 42; }
console.log("extra", [1, 2].reduce((a: number, b: number) => { ignoredOrder += "c"; return a + b; }, 0, ignored()), ignoredOrder);
function failExtra(): number { throw new Error("extra failed"); }
try { [1].reduce((a: number, b: number) => { console.log("wrong callback"); return a + b; }, 0, failExtra()); }
catch (error) { if (error instanceof Error) console.log("extra-error", error.message); }
