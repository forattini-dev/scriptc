// @rust-only
// @no-engine
export {};

const initial: unknown = 5;
const nested = ["outer", "inner"].reduceRight<unknown>(
  (acc, key) => ({ [key]: acc }),
  initial,
);
console.log(
  "computed-reduce-right",
  JSON.stringify(nested) === '{"outer":{"inner":5}}',
);
