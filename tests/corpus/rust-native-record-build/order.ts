let trace = "";
const source = { b: "old", a: "a" };
function mark(text: string): string { trace = trace + text; return text; }
function getSource(): typeof source { trace = trace + "S"; return source; }
function change(): string { trace = trace + "M"; source.b = "changed"; return "last"; }
const output = { first: mark("F"), ...getSource(), b: mark("B"), last: change() };
console.log("case", trace, output.first, output.b, output.last, source.b, Object.keys(output).join("|"));
const snapshot = { ...source, last: change() };
source.b = "after";
console.log("case", snapshot.b, source.b);
function pick(yes: boolean): { a: string; b?: string; c: string } {
  return { ...(yes ? { b: "b", a: "a" } : { a: "a" }), c: "c" };
}
function copy(input: { a: string; b?: string; c: string }): { a: string; b?: string; c: string } { return { ...input }; }
console.log("case", Object.keys(copy(pick(true))).join("|"), Object.keys(copy(pick(false))).join("|"));
