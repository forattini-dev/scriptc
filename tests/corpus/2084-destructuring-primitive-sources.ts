// @dynamic
// Destructuring PRIMITIVE and unit sources (`let { toFixed } = 1`): JS
// reads through the value's wrapper object — prototype members included —
// or throws its TypeError on null/undefined. Under --dynamic the value
// marshals into the engine and the real pattern runs, so the extracted
// members are the engine's own (an unbound prototype method behaves
// exactly like Node's, .call receiver rules included); a static build
// reports the SC2010 dynamic-family choice.
//
// The receiver rejection below pins the error TYPE, not its message: the
// throw comes from inside the island engine, and quickjs-ng's wording for
// an engine-internal TypeError is its own, not V8's ("not a number" where
// V8 says "Number.prototype.toFixed requires that 'this' be a Number").
// The vendored engine is an unmodified upstream snapshot by policy, and
// its prebuilt archive is cached by upstream commit, so that text is not
// ours to align — see packages/runtime/vendor/README.md.
{ let { toString } = 1; console.log(`${toString.call(9)}`); }
{ const { toString: toStringRadix } = 1; console.log(`${toStringRadix.call(15, 16)}`); }
{
  let { toFixed } = 1;
  console.log(`${toFixed.call(2.5, 1)}`);
  try {
    toFixed.call("2.5", 1);
  } catch (error) {
    console.log((error as Error).name);
  }
}
const { length } = "abc";
console.log(length);
const [c1, c2] = "xy";
console.log(`${c1}${c2}`);
try {
  const { anything } = null as any;
} catch (e) { console.log("null throws"); }
console.log("done");
