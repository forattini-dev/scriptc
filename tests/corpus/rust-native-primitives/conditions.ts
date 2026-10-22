// @rust-only
// @no-engine
function indent(value: number | string | undefined): string {
  if (typeof value === "number") return " ".repeat(Math.min(10, Math.max(0, Math.floor(value))));
  else if (typeof value === "string") return value.repeat(2);
  return "none";
}
console.log("branches", indent(2.9).length, indent("é"), indent(undefined));
let mutable: number | string = "initial";
function change(): void { mutable = 7; }
if (typeof mutable === "string") {
  change();
  console.log("live", typeof mutable, typeof mutable === "string", "number" === typeof mutable);
}
function captured(value: number | string | undefined): void {
  const change = (): void => { value = 9; };
  if (typeof value === "string") {
    change();
    console.log("capture", typeof value, typeof value !== "string");
  }
}
captured("initial");
let trace = "";
class Probe {
  get value(): number | string { trace = trace + "get"; return "text"; }
}
console.log("getter", typeof new Probe().value, trace);
// @ts-expect-error Observe the JavaScript TDZ error at runtime.
try { console.log(typeof later); }
catch (error) { if (error instanceof Error) console.log("tdz", error.name); else throw error; }
const later = "ready";
console.log("initialized", typeof later);

try { throw "text"; }
catch (error) { console.log("caught", typeof error, typeof error === "string"); }
try { throw new Error("failure"); }
catch (error) { console.log("caught object", typeof error, typeof error === "object"); }
