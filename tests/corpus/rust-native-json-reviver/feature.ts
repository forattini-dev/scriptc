// @rust-only
// @no-engine
// @ts-nocheck
export {};
const featureCache = new Map();
function supportsContextSource() {
  const fingerprint = JSON.parse.toString();
  if (featureCache.has(fingerprint)) return featureCache.get(fingerprint);
  const result = JSON.parse("1", (_, __, context) => !!context?.source && context.source === "1");
  featureCache.set(fingerprint, result);
  return result;
}
console.log("feature", supportsContextSource() === true, supportsContextSource() === true, featureCache.size === 1);
const integer = /^-?\d+$/;
const parsed = JSON.parse('{"large":9007199254740993,"small":123,"decimal":1.25}', (key, value, context) => {
  if (typeof value === "number" && (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) && context && integer.test(context.source)) return BigInt(context.source);
  return value;
});
console.log("values", parsed.large === 9007199254740993n, parsed.small === 123, parsed.decimal === 1.25);
console.log("constants", Number.MAX_SAFE_INTEGER === 9007199254740991, Number.MIN_SAFE_INTEGER === -9007199254740991, Number.MAX_VALUE === 1.7976931348623157e308, Number.MIN_VALUE === 5e-324, Number.EPSILON === 2.220446049250313e-16, Number.POSITIVE_INFINITY === 1 / 0, Number.NEGATIVE_INFINITY === -1 / 0, Number.NaN !== Number.NaN);
function shadow(Number: {MAX_SAFE_INTEGER: number}) { return Number.MAX_SAFE_INTEGER; }
console.log("shadow", shadow({MAX_SAFE_INTEGER: 7}) === 7);
