// @ts-nocheck
// @rust-only
// @no-engine
function parenthesized(value: { child: { value: number } } | undefined): number {
  return (value?.child).value;
}
function chain(value: { child: { value: number } } | undefined): number | undefined {
  return value?.child.value;
}
console.log("present", parenthesized({ child: { value: 7 } }), chain({ child: { value: 9 } }) === 9);
console.log("chain", chain(undefined) === undefined);
try { parenthesized(undefined); }
catch (error) { console.log("parentheses", error instanceof TypeError, String(error.message)); }
