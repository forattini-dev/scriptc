/// <reference lib="es2024.string" />
// @ts-nocheck
// @rust-only
// @no-engine
const text = "A😀éZ";
console.log("slice", text.slice(), text.slice(1), text.slice(1, 3), text.slice(-2), text.slice(3, 1));
console.log("bounds", text.slice(-1e300, 1e300), text.slice(1e300), text.slice(0 / 0, 0 / 0));
console.log("substring", text.substring(3, 1), text.substring(-4, 1), text.substring(), text.substring(1, undefined));
console.log("char", text.charAt(), text.charAt(1).charCodeAt(0), text.charAt(2).charCodeAt(0), text.charAt(-1), text.charCodeAt(50));
console.log("search", text.indexOf("é"), text.includes("😀"), text.startsWith("😀", 1), text.endsWith("é", 4), text.endsWith("Z", undefined));
console.log("coercion", "012345".slice("2.8", null), "xundefined".includes(), "atrue".endsWith(true), "nullx".indexOf(null));
const whitespace = "\ufeff\u00a0\u2003 x \u2028";
console.log("trim", whitespace.trim(), whitespace.trimStart().length, whitespace.trimEnd().length, "\u0085x\u0085".trim().length);
console.log("case", "éßΣ".toUpperCase(), "ÉΣABC".toLowerCase());
console.log("pad", "x".padStart(4), "x".padEnd(4, "ab"), "x".padStart(4, undefined), "x".padEnd(0), "x".padEnd(5, ""));
console.log("replace", "aba".replace("a", "$$$&"), "aba".replaceAll("a", "x"), "abc".replace("b"), "abc".replaceAll("", "-"));
function optional(end: number | undefined): string { return text.slice(1, end); }
console.log("optional", optional(undefined), optional(3));
let trace = "";
function effect(value: string): string { trace = trace + value; return value; }
console.log("effects", effect(" abc ").trim(effect("ignored")), trace);
trace = "";
console.log("eager", effect("abcdef").slice(effect("1"), effect("3"), effect("extra")), trace);
console.log("wellformed", text.isWellFormed(), text.toWellFormed());
function paddingError(length: number): void {
  try { "x".padStart(length, "😀"); }
  catch (error) { if (error instanceof Error) console.log("pad error", error.name, error.message); else throw error; }
}
paddingError(536870889);
paddingError(1 / 0);
paddingError(1e300);
console.log("empty fill", "x".padEnd(1 / 0, ""));
