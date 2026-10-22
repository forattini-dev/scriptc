/// <reference path="./augmented-standard.d.ts" />
/// <reference lib="es2024.string" />
// @ts-nocheck
// @rust-only
// @no-engine
const convert = String;
let mutable = convert;
function pick(): typeof String { return String; }
function invoke(fn: typeof String): string { return fn(); }
console.log("identity", convert === String, mutable === convert, pick() === convert);
console.log("omission", String() === "", convert() === "", invoke(convert) === "", String(undefined));
console.log("primitives", String(null), convert(true), convert(false), convert(42), convert(-0), convert(1 / 0), convert(0 / 0));
console.log("symbol", String(Symbol("name")), convert(Symbol()));
const values: unknown[] = [1, "text", true, null, undefined, Symbol("value")];
console.log("mapped", values.map(String).join("|"), [1, 2, 3].map(convert).join("|"));
const half = "😀".slice(0, 1);
console.log("utf16", convert(half) === half, convert(half).charCodeAt(0), convert(half).isWellFormed());
const symbolText = convert(Symbol(half));
console.log("symbol utf16", symbolText === "Symbol(" + half + ")", symbolText.charCodeAt(7), symbolText.isWellFormed());
let trace = "";
function first(): number { trace = trace + "first"; return 7; }
function extra(): void { trace = trace + "extra"; }
console.log("extras", convert(first(), extra()), trace);
console.log("void", String(extra()), trace);
function fail(): number { trace = trace + "throw"; throw new Error("failure"); }
trace = "";
try { String(first(), fail()); }
catch (error) { if (error instanceof Error) console.log("exception", error.message, trace); else throw error; }
function template(value: unknown): void {
  try { console.log(`${value}`); }
  catch (error) { if (error instanceof Error) console.log("coercion", error.name, error.message); else throw error; }
}
template(Symbol("template"));
const numbers = [10, 20];
function rest(...args: unknown[]): number { return args.length; }
function tail(value: number, ...args: unknown[]): string { return String(value) + ":" + args.length; }
function noTail(value: number, index: number, array: number[], ...args: unknown[]): string {
  return String(array === numbers) + ":" + String(index) + ":" + args.length;
}
console.log("rest", numbers.map(rest).join("|"), numbers.map(tail).join("|"), numbers.map(noTail).join("|"));
console.log("inline rest", numbers.map((...args: unknown[]) => args.length).join("|"));
console.log("inline tail", numbers.map((value: number, ...args: unknown[]) => String(value) + ":" + args.length).join("|"));
function shadow(): void {
  const String = (value: number): string => "custom:" + value;
  console.log("shadow", String(2), [3].map(String).join("|"));
}
shadow();
