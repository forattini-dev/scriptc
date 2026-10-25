// @rust-only
// @no-engine
export {};
let trace = "";
function boolean(mark: string): boolean { trace = trace + mark; return false; }
function text(mark: string): string { trace = trace + mark; return mark; }
function choose(mark: string, yes: boolean): boolean { trace = trace + mark; return yes; }
function source() { trace = trace + "S"; return { value: boolean("B"), keep: text("K") }; }
function build(yes: boolean) {
  return { before: text("A"), ...source(), ...(choose("C", yes) ? { value: text("T") } : { value: boolean("F") }), value: text("Z") };
}
const first = build(true);
console.log("yes", trace, first.value, first.keep, Object.keys(first).join("|"));
trace = "";
const second = build(false);
console.log("no", trace, second.value, second.keep, Object.keys(second).join("|"));
trace = "";
function fail(): boolean { trace = trace + "X"; throw "stop"; }
try { const unused = { ...{ value: fail() }, ...{ value: text("!") } }; console.log(unused.value); }
catch { console.log("throw", trace); }
trace = "";
const hooks = { valueOf(): number { trace = trace + "!"; return 1; }, toString(): string { trace = trace + "?"; return "hook"; } };
const overwritten = { ...{ value: hooks }, ...{ value: text("Q") } };
console.log("hooks", trace, overwritten.value);
