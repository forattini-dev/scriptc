// @rust-only
// @no-engine
// Structurally identical records retain each instance's creation order,
// including return boundaries and shape-changing spread copies.
function choose(reverse: boolean): { a: number; b: number } {
  if (reverse) return { b: 2, a: 1 };
  return { a: 1, b: 2 };
}
console.log(JSON.stringify(choose(false)));
console.log(JSON.stringify(choose(true)));
console.log(Object.keys(choose(true)).join(","));
console.log(JSON.stringify({ ...choose(true), c: 3 }));
