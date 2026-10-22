// @ts-nocheck
// @rust-only
// @no-engine
function brand(value: unknown): boolean { return Array.isArray(value); }
console.log("array", brand([1, 2]), brand(["a"]), brand([[1]]), brand([]));
console.log("scalar", brand("abc"), brand(3), brand(true), brand(null), brand(undefined), brand(Symbol("x")));
console.log("object", brand({ length: 1 }), brand(() => 1), Array.isArray(new Map()), Array.isArray(new Set()), Array.isArray(new Error("x")));
console.log("typed bytes", brand(new Uint8Array([1, 2])));
console.log("promise", brand(Promise.resolve([1])));
console.log("negated", !Array.isArray([1]), !brand("x"));
console.log("assertion", Array.isArray({ length: 0 } as unknown as number[]));
const tuple: [number, string] = [1, "text"];
console.log("tuple", Array.isArray(tuple), brand(tuple), brand({ 0: 1, 1: "text" }));
function union(value: string | number[]): boolean { return Array.isArray(value); }
console.log("union", union("x"), union([1]), Array.isArray(), Array.isArray(undefined));
let live: unknown = [1];
function replace(): number { live = "changed"; return 9; }
console.log("snapshot", Array.isArray(live, replace()), Array.isArray(live));
live = [1];
if (Array.isArray(live)) {
  replace();
  console.log("live", Array.isArray(live));
}
function length(value: unknown): number { if (Array.isArray(value)) return value.length; return -1; }
console.log("guard", length([1, 2, 3]), length("abc"));
let trace = "";
function first(): number[] { trace = trace + "first"; return [1]; }
function extra(): void { trace = trace + "extra"; }
console.log("eager", Array.isArray(first(), extra()), trace);
console.log("void", Array.isArray(extra()), Math.sqrt(extra()), "x".repeat(extra()), trace);
function fail(): number { trace = trace + "throw"; throw new Error("failure"); }
trace = "";
try { Array.isArray(first(), fail()); }
catch (error) { if (error instanceof Error) console.log("throwing extra", error.message, trace); else throw error; }
trace = "";
class Probe { get length(): number { trace = trace + "getter"; return 1; } }
console.log("no hooks", brand(new Probe()), trace);
function shadow(): void {
  const Array = { isArray: (value: number): number => value + 1 };
  console.log("shadow", Array.isArray(2));
}
shadow();
const thrown = [1];
try { throw thrown; }
catch (value) { console.log("caught", Array.isArray(value), value === thrown); }
try { throw tuple; }
catch (value) { console.log("caught tuple", Array.isArray(value)); }
function throwUnion(value: string | number[]): void { throw value; }
try { throwUnion([1]); }
catch (value) { console.log("caught array arm", Array.isArray(value)); }
try { throwUnion("text"); }
catch (value) { console.log("caught other arm", Array.isArray(value)); }
