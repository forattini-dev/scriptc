// @rust-only
// @no-engine
// @ts-nocheck
export {};
const values = [1, 2, 3];
const context = {needle: 2};
const callback = function(this: {needle: number}, value: number, index: number, source: number[]): boolean {
  return this.needle === value && index === 1 && source === values;
};
console.log(values.some(callback, context));
const rest = (...args: unknown[]): boolean => args.length === 3 && args[0] === 2;
console.log(values.some(rest));
let count = 0;
try { values.some(() => { count++; throw new Error("stop"); }); }
catch (error) { console.log(error instanceof Error, String(error.message), count); }
