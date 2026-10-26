// @rust-only
// @no-engine
export {};
let events = "";
function receiver(): string { events = events + "receiver;"; return "abc"; }
function key(): number { events = events + "key;"; return 1; }
const value = receiver()[key()];
console.log("order", events, value === "b");
function bad(): number { events = events + "throw;"; throw new Error("key"); }
try { receiver()[bad()]; } catch (error) { console.log("caught", (error as Error).message, events); }
function input(value: string | null, index: number): string | undefined { return value![index]; }
let calls = 0;
function next(): number { calls++; return 0; }
try { const value: string | null = null; value![next()]; }
catch (error) { console.log("nullish", calls, (error as Error).name); }
console.log("typed", input("ok", 0) === "o");
