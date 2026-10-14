// @rust-only
// @no-engine
// The checker infers number; the closure must preserve a missing read and defaults of another type.
const numbers: number[] = [7];
const missing = () => numbers[100];
const defaulted = () => numbers[100] ?? "fallback";
const present = () => numbers[0] ?? "fallback";
const block = () => { return numbers[100] ?? "block"; };
const expression = function () { return numbers[100] || "expression"; };
function take(f: () => unknown): unknown { return f(); }
function viaBinding(i: number): number {
  const read = () => numbers[i];
  return read();
}
console.log(missing(), missing() === undefined, defaulted(), present(), block(), expression());
console.log(take(() => numbers[100]), take(() => numbers[100] ?? "taken"));
console.log(viaBinding(100), viaBinding(0));
console.log(numbers.map(() => numbers[100] ?? "mapped").join(","));
let calls = 0;
const fallback = () => numbers[0] ?? (++calls, "unused");
console.log(fallback(), calls);
const missingAnd = () => numbers[100] && "unreachable";
const presentAnd = () => numbers[0] && "and";
console.log(missingAnd(), presentAnd());
