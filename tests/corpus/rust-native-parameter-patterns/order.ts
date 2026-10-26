let trace = "";
const source: { first?: number; second?: number; later?: number; extra: string } = {extra: "kept"};
function first(): number { trace = trace + "A"; source.second = 9; source.later = 11; return 1; }
function second(): number { trace = trace + "B"; return 2; }
function receiver() { trace = trace + "S"; return source; }
function extra(): string { trace = trace + "E"; return "argument"; }
function choose({first: a = first(), second: b = second(), ...rest}: typeof source, ignored: string): string {
  trace = trace + "C";
  return String(a) + ":" + String(b) + ":" + String(rest.later) + ":" + Object.keys(rest).join("|");
}
console.log("order", choose(receiver(), extra()), trace);
console.log("source", Object.keys(source).join("|"), source.first === undefined);
