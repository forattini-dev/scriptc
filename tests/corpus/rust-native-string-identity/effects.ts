// @ts-nocheck
// @rust-only
// @no-engine
let trace = "";
function receiver(): string { trace = trace + "r"; return "text"; }
function number(): number { trace = trace + "n"; return 42; }
function nothing(): void { trace = trace + "v"; }
function object() {
  trace = trace + "o";
  return { valueOf(): number { trace = trace + "BAD"; return 1; }, toString(): string { trace = trace + "BAD"; return "bad"; } };
}
console.log("ignored", receiver().toString(number(), nothing(), object(), null, undefined, 1n), trace);
trace = "";
console.log("ignored valueOf", receiver().valueOf(object(), nothing(), number()), trace);
function fail(label: string): string { trace = trace + label; throw new Error(label); }
trace = "";
try { receiver().toString(number(), fail("x"), object()); }
catch (error) { console.log("argument throws", error instanceof Error, trace); }
trace = "";
try { fail("x").valueOf(number()); }
catch (error) { console.log("receiver throws", error instanceof Error, trace); }
let mutable = "before";
function change(): void { mutable = "after"; }
console.log("snapshot", mutable.toString(change()), mutable);
