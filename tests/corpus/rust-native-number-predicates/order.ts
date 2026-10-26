// @ts-nocheck
// @rust-only
// @no-engine
export {};
let state = 0;
function input(): number { state = state * 10 + 1; return 4; }
function extra(): string { state = state * 10 + 2; return "unused"; }
console.log(Number.isSafeInteger(input(), extra()), state);
function fail(): number { state = state * 10 + 3; throw new Error("stop"); }
try { Number.isInteger(input(), fail()); } catch (error) { console.log(error instanceof Error, state); }
const object = { valueOf() { state = 999; return 1; } };
console.log(Number.isFinite(object), Number.isNaN(object), Number.isInteger(object), Number.isSafeInteger(object), state);
