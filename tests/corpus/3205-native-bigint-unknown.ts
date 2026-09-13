// @rust-only
// @no-engine
function describe(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  return typeof value;
}
const value: unknown = 9007199254740993n;
const zero: unknown = 0n;
console.log(describe(value), describe(42), describe("hello"));
console.log(String(value), Boolean(value), Boolean(zero));
console.log(value, zero);
console.log(value === 9007199254740993n, value === 9007199254740992n);
const extracted = value as bigint;
console.log(String(extracted + 7n));
