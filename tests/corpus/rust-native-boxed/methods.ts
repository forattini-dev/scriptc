// @rust-only
// @no-engine
const one = new Number(1); const two = new Number(2);
console.log("stable", one.valueOf === two.valueOf);
const value = one.valueOf;
console.log("call", value.call(two), value.call(3));
try { value(); } catch (e) { console.log("detached", (e as Error).name, (e as Error).message); }
try { value.call(new String("bad") as any); } catch (e) { console.log("brand", (e as Error).name, (e as Error).message); }
let count = 0;
function receiver(): any { count = count + 1; return two; }
function extra(): number { console.log("extra"); return 99; }
console.log("ordered", receiver().valueOf(extra()) as number, count);
const custom: any = { factor: 77, valueOf(): number { return this.factor; } };
console.log("custom", custom.valueOf() as number);
try { const nil: any = null; nil.valueOf(extra()); } catch (e) { console.log("null", (e as Error).name, (e as Error).message); }
let trace = "";
function first(): number { trace = trace + "first"; return 5; }
function second(): number { trace = trace + "second"; return 9; }
// @ts-expect-error Extra arguments still evaluate.
const constructed = new Number(first(), second());
console.log("constructor order", constructed.valueOf(), trace);

const s = new String("s"); const b = new Boolean(false);
console.log("other identities", s.valueOf === new String("t").valueOf, b.valueOf === new Boolean(true).valueOf);
console.log("other calls", s.valueOf.call("primitive"), b.valueOf.call(true));
try { const detached = s.valueOf; detached(); } catch (e) { console.log("string detached", (e as Error).message); }
try { b.valueOf.call(s as any); } catch (e) { console.log("boolean brand", (e as Error).message); }
console.log("brackets", one["valueOf"](), s["valueOf"]());
