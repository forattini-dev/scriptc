// @rust-only
// @no-engine
// @ts-nocheck
export {};
let log = "";
const values: number[] = [1, 2];
function input(): number[] { log = log + "r"; return values; }
function callback(): (value: number) => boolean {
  log = log + "c";
  return function(this: any, value: number): boolean { log = log + String(value); return this.limit > value; };
}
function mark(label: string, value: any): any { log = log + label; return value; }
console.log("effects", input().every(callback(), mark("t", {limit: 9}), mark("x", 0)), log);
log = "";
try { values.every((value: number): boolean => { log = log + String(value); throw new Error("stop"); }); }
catch (error) { console.log("throw", String(error.message), log); }
const predicate = (...args: any[]): any => args.length === 3 && args[0] !== 0;
console.log("rest", values.every(predicate));
