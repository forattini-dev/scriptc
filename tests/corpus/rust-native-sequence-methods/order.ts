// @ts-nocheck
// @rust-only
// @no-engine
export {};
let state = 0;
const values = [1, 2, 3];
function receiver(): number[] { state = state * 10 + 1; return values; }
function arg(value: number): number { state = state * 10 + value; return value; }
console.log("slice", receiver().slice(arg(2), arg(3), arg(4)).join(","), state);
state = 0;
console.log(receiver().some(value => { state = state * 10 + 4; return value === 1; }, arg(2), arg(3)), state);
state = 0;
try { receiver().slice(Symbol("bad"), arg(2), arg(3)); }
catch (error) { console.log(error instanceof TypeError, String(error.message), state); }
try { "x".repeat(Symbol("count")); }
catch (error) { console.log(error instanceof TypeError, String(error.message)); }
state = 0;
function fail(): number { state = state * 10 + 3; throw new Error("argument"); }
try { receiver().some(() => { state = 999; return true; }, arg(2), fail()); }
catch (error) { console.log(error instanceof Error, state); }
