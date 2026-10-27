// @rust-only
// @no-engine
// @ts-nocheck
export {};
function invalid(source: any): void {
  try { Buffer.from(source); console.log("unexpected"); }
  catch(error) { console.log("source-error", error instanceof TypeError, String(error.message), String(error.code)); }
}
invalid(undefined); invalid(null); invalid(1); invalid(-0); invalid(true); invalid(3n); invalid(Symbol("x")); invalid({});
function invalidEncoding(encoding: any): void {
  try { Buffer.from("ab").toString(encoding); console.log("unexpected"); }
  catch(error) { console.log("encoding-error", error instanceof TypeError, String(error.message), String(error.code)); }
}
invalidEncoding(""); invalidEncoding("bogus"); invalidEncoding(null); invalidEncoding(false); invalidEncoding(0); invalidEncoding(3n); invalidEncoding(Symbol("x"));
try { Buffer.from("ab", "bogus"); } catch(error) { console.log("from-encoding", error instanceof TypeError, String(error.message), String(error.code)); }
console.log("ignored-encoding", Buffer.from([65], "bogus").toString());
try { Buffer.from([2n]); } catch(error) { console.log("bigint-element", error instanceof TypeError, String(error.message)); }
try { Buffer.from([Symbol("x")]); } catch(error) { console.log("symbol-element", error instanceof TypeError, String(error.message)); }
console.log("lengths", Buffer.from({length: -1}).length, Buffer.from({length: Number.NaN}).length, Buffer.from({length: 1.9}).length);
