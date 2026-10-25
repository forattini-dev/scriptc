// @rust-only
// @no-engine
export {};
type Base = { width: number };
type View = { width: number; height?: number };
let trace = "";
const base: Base = { width: 2 };
function widen(value: Base): View { return value; }
const alias = widen(base);
function source(): Base { trace = trace + "S"; return base; }
function change(): number { trace = trace + "C"; alias.height = 7; return 0; }
function read(value: View, ignored: number): number { trace = trace + "R"; return value.width + (value.height ?? 1); }
console.log("order", read(source(), change()), trace, Object.keys(base).join("|"));
trace = "";
function fail(): number { trace = trace + "X"; throw "stop"; }
try { read(source(), fail()); } catch { console.log("abrupt", trace); }
