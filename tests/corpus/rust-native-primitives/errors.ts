// @ts-nocheck
// @rust-only
// @no-engine
function repeat(text: string, count: number): void {
  try { console.log("unexpected", text.repeat(count)); }
  catch (error) { if (error instanceof RangeError) console.log("caught", error.name, error.message); else throw error; }
}
repeat("x", -1);
repeat("", -1.9);
repeat("x", 1 / 0);
repeat("", -1 / 0);
repeat("x", 536870889);
repeat("😀", 268435445);
repeat("x", 9007199254740992);
let trace = "";
function extra(): number { trace = trace + "extra"; return 0; }
try { "x".repeat(-1, extra()); } catch (error) { if (error instanceof RangeError) console.log("order", trace, error.message); }

function fail(label: string): number { trace = trace + label; throw new Error(label); }
trace = "";
try { "x".repeat(-1, fail("argument")); }
catch (error) { if (error instanceof Error) console.log("argument-first", trace, error.name, error.message); }
trace = "";
try { Math.min(0 / 0, fail("min")); }
catch (error) { if (error instanceof Error) console.log("nan-does-not-skip", trace, error.message); }
function receiver(): string { trace = trace + "receiver"; throw new Error("receiver"); }
trace = "";
try { receiver().repeat(extra()); }
catch (error) { if (error instanceof Error) console.log("receiver-first", trace, error.message); }
