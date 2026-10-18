let trace = "";
function mark(text: string): string { trace = trace + text; return text; }
function fail(): { a: string } { trace = trace + "!"; throw new Error("stop"); }
try { const value = { first: mark("F"), ...fail(), last: mark("wrong") }; console.log("case", value.a); }
catch { console.log("case", "caught", trace); }
const source = { a: "a" };
function failValue(): string { trace = trace + "V"; throw new Error("value"); }
try { const value = { ...source, last: failValue() }; console.log("case", value.last); }
catch { console.log("case", "value", trace, source.a); }
function finish(): { a: string; last: string } {
  try { return { ...source, last: mark("T") }; }
  finally { trace = trace + "Z"; }
}
console.log("case", finish().last, trace);
