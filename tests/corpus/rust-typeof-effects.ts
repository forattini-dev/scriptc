// @no-engine
let calls = 0;
function text(): string { calls++; console.log("text", calls); return "value"; }
function count(): number { calls++; console.log("number", calls); return calls; }
function record(): { value: number } { calls++; return { value: calls }; }
function fails(): string { calls++; throw new Error("typeof operand failed"); }
console.log(typeof text(), typeof count(), typeof record(), calls);
if (typeof text() === "string") console.log("chosen", calls);
if (typeof count() !== "number") console.log("unreachable");
console.log(false && typeof text() === "string", calls);
try { console.log(typeof fails()); } catch (error) { console.log("caught", calls); }
