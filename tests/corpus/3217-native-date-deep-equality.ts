// @rust-only
// @no-engine
import assert from 'node:assert';
function compare(left: unknown, right: unknown): void {
  try { assert.deepStrictEqual(left, right); console.log(true); }
  catch { console.log(false); }
}
compare(new Date(0), new Date(0));
compare(new Date(0), new Date(1));
const invalid = new Date(NaN);
compare(invalid, invalid);
compare(invalid, new Date(NaN));
compare(invalid, new Date(0));
