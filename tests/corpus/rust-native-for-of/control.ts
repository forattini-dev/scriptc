// @rust-only
// @no-engine
export {};
for (const value of [1, 2, 3, 4]) {
  try {
    if (value === 1) continue;
    if (value === 3) break;
    console.log("body", value);
  } finally { console.log("finally", value); }
}
function first(values: number[]): number {
  for (const value of values) { try { return value; } finally { console.log("return-finally", value); } }
  return -1;
}
console.log("return", first([9, 10]), first([]));
try {
  for (const value of [1, 2, 3]) { if (value === 2) throw new Error("stop"); console.log("before-throw", value); }
} catch (error) { if (error instanceof Error) console.log("throw", error.message); else throw error; }
const values = [1];
for (const value of values) {
  try { continue; }
  finally { if (value < 3) values.push(value + 1); console.log("append-finally", value); }
}
let checks = 0;
function fail(): number[] { checks++; throw new Error("source"); }
try { for (const value of fail()) console.log(value); }
catch (error) { if (error instanceof Error) console.log("source-throw", error.message, checks); else throw error; }
