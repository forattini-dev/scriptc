/// <reference lib="es2024.string" />
// @ts-nocheck
// @rust-only
// @no-engine
function append(value: unknown): string { return value + "!"; }
function prepend(value: unknown): string { return "!" + value; }
function union(value: string | number | boolean | null | undefined): string { return value + "!"; }
console.log("append", append("text"), append(3), append(true), append(null), append(undefined));
console.log("prepend", prepend("text"), prepend(3), prepend(false), prepend(null), prepend(undefined));
console.log("union", union("text"), union(3), union(true), union(null), union(undefined));
const high = "😀".slice(0, 1);
console.log("utf16", append(high) === high + "!", append(high).charCodeAt(0), append(high).isWellFormed());
let trace = "";
function left(value: unknown): unknown { trace = trace + "L"; return value; }
function right(): string { trace = trace + "R"; return "!"; }
try { console.log(left(Symbol("value")) + right()); }
catch (error) { if (error instanceof Error) console.log("symbol", error.name, error.message, trace); else throw error; }
trace = "";
function effect(): void { trace = trace + "V"; }
console.log("void", effect() + right(), trace);
let live: unknown = "before";
function mutate(): string { live = "after"; return "!"; }
console.log("snapshot", live + mutate(), live === "after");
trace = "";
function fail(): string { trace = trace + "T"; throw new Error("right failed"); }
try { console.log(left(Symbol("value")) + fail()); }
catch (error) { if (error instanceof Error) console.log("abrupt", error.message, trace); else throw error; }
try { throw "caught"; }
catch (value) { console.log("caught", value + "!"); }
function noise(value: unknown): unknown {
  const matches = typeof value === "string" && /^x$/.test(value);
  if (matches) return value + "n";
  return value;
}
console.log("alias guard", String(noise("x")), String(noise(3)));
