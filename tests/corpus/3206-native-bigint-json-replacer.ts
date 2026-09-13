// @rust-only
// @no-engine
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
const object: unknown = { amount: 9007199254740993n, nested: { amount: -17n } };
console.log(JSON.stringify(object, replacer));
const copied: unknown = structuredClone(object);
console.log(JSON.stringify(copied, replacer));
const value: unknown = 9007199254740993n;
console.log(JSON.stringify(value, replacer));
try { console.log(JSON.stringify(object)); }
catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}
const values: unknown[] = [value, 0n, -1n];
console.log(JSON.stringify(values, replacer));
