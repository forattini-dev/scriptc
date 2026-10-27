// @rust-only
// @no-engine
// @ts-nocheck
export {};
function range(value: number, digits: number): void {
  try { console.log("unexpected", value.toFixed(digits)); }
  catch (error) { console.log("range", error instanceof RangeError, String(error.message)); }
}
range(1, -1); range(1, 101); range(Number.NaN, 101);
range(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
console.log("truncate", (1.25).toFixed(-0.9), (1.25).toFixed(Number.NaN));
try { (1).toFixed(2n); } catch (error) { console.log("bigint", error instanceof TypeError, String(error.message)); }
try { (1).toFixed(Symbol("digits")); } catch (error) { console.log("symbol", error instanceof TypeError, String(error.message)); }
