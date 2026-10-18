let trace = "";
function mark(value: string): string { trace = trace + value; return value; }
function fail(): string { trace = trace + "!"; throw new Error("stop"); }
function choose(): (...parts: string[]) => string {
  trace = trace + "C";
  return (...parts: string[]) => { trace = trace + "R"; return parts.join("|"); };
}
const value = choose()(mark("A"), mark("B"));
console.log("order", trace, value);
try { choose()(mark("D"), fail(), mark("wrong")); } catch { console.log("caught", trace); }
function defaults(value: string = mark("F"), ...parts: string[]): string { trace = trace + "R"; return value + parts.join(""); }
console.log("defaults", defaults(undefined, mark("E")), trace);
