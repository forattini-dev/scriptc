type Spec = { kind: "a"; text: string } | { kind: "b"; count: number };
type Out = Spec & { flag: string; last: string };
let trace = "";
function source(b: boolean): Spec { trace = trace + "source|"; if (b) return { kind: "b", count: 2 }; return { kind: "a", text: "x" }; }
function mark(s: string): string { trace = trace + s + "|"; return s; }
function wrap(b: boolean): Out { return { ...source(b), flag: mark("flag"), last: mark("last") }; }
function show(b: boolean): void { const out = wrap(b); console.log("case", out.kind, out.flag, out.last, trace, Object.keys(out).join("|")); trace = ""; }
show(false); show(true);
function fail(): string { trace = trace + "throw|"; throw new Error("stop"); }
function broken(b: boolean): Out { return { ...source(b), flag: fail(), last: mark("unreachable") }; }
function test(b: boolean): void { try { broken(b); } catch { console.log("case", trace); } finally { trace = ""; } }

test(true); test(false);
