// @rust-only
// @no-engine
// @npm-static: auto
// Ordinary inferred call storage keeps its existing typed representation.
const direct = JSON.stringify({ answer: 42 });
console.log("direct", direct);
function twice(value: number): number { return value * 2; }
const result = twice(21);
console.log("typed", result);
