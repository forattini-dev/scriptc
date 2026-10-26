// @ts-nocheck
// @rust-only
// @no-engine
export {};
const values: any[] = [0, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 9007199254740991, 9007199254740992, -9007199254740991, "1", true, null, undefined, 1n, Symbol("x"), {}, []];
for (let index = 0; index < values.length; index++) {
  const value = values[index];
  console.log(index, Number.isFinite(value), Number.isNaN(value), Number.isInteger(value), Number.isSafeInteger(value));
}
console.log("rounding", Number.isInteger(4500000000000000.1), Number.isSafeInteger(9007199254740991.1));
console.log("missing", Number.isFinite(), Number.isNaN(), Number.isInteger(), Number.isSafeInteger());
