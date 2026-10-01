// @rust-only
// @no-engine
// Values, entries and for-in observe the same per-instance own-key order.
function choose(reverse: boolean): { a: number; b: number } {
  if (reverse) return { b: 2, a: 1 };
  return { a: 1, b: 2 };
}
console.log(Object.values(choose(false)).join(","));
console.log(Object.values(choose(true)).join(","));
console.log(JSON.stringify(Object.entries(choose(true))));
for (const key in choose(true)) console.log(key);
