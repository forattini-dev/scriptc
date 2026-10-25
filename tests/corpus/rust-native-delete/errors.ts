// @rust-only
// @no-engine
// @ts-nocheck
export {};
function attempt(value: any, key: string): void {
  try { console.log("result", delete value[key]); }
  catch (error) { console.log("error", String(error.name), String(error.message)); }
}
attempt(null, "x");
attempt(undefined, "x");
attempt([1], "length");
attempt("abc", "length");
attempt("\u{1f600}", "1");
attempt("abc", "01");
attempt("abc", "3");
attempt(3, "x");
attempt(true, "x");
attempt(3n, "x");
let calls = 0;
function key(): string { calls++; return "x"; }
try { delete (null as any)[key()]; } catch (error) { console.log("evaluated", calls, String(error.name)); }
