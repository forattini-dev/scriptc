// @rust-only
// @no-engine
export {};
let trace = "";
const items: number[] = [1];
function source(): number[] { trace = trace + "s"; return items; }
function grow(): number { trace = trace + "g"; items.push(2); return 3; }
function tail(): number[] { trace = trace + "t"; return [4, 5]; }
const values = [0, ...source(), grow(), ...source(), ...tail(), 6];
console.log(values.join(","));
console.log(trace);
let emptyCount = 0;
function empty(): number[] { emptyCount = emptyCount + 1; return []; }
const blanks = [...empty(), ...empty(), 7];
console.log(blanks.join(","));
console.log(emptyCount);
function stop(): number[] { trace = trace + "!"; throw new Error("spread"); }
trace = "";
try { [0, ...source(), ...stop(), grow(), ...tail()]; }
catch (error) { console.log((error as Error).message); console.log(trace); }
