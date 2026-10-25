// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace = "";
const data = {count: 1};
function receiver() { trace = trace + "receiver;"; return data; }
function key() { trace = trace + "key;"; data.count = 4; return "count"; }
console.log("order", receiver()[key()] === 4, trace);
function failure(): string { trace = trace + "throw;"; throw new Error("key-failed"); }
trace = "";
try { receiver()[failure()]; } catch (error) { console.log("throw", error.message === "key-failed", trace); }
console.log("after", data.count === 4);
const dataWithMethod = {read: (input: number): number => input + 1};
const methodName = "read";
const fn = dataWithMethod[methodName];
console.log("function", fn(6) === 7, fn === dataWithMethod.read);
