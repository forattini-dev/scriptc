// @rust-only
// @no-engine
export {};
let total = 0;
const callback = (value: number): number => total += value;
const row = [3, callback] as const;
console.log("tuple", row[0], row[1](2), row.length, Array.isArray(row));
console.log("identity", row[1] === callback);
function apply(value: readonly [number, (value: number) => number]): number {
  return value[1](value[0]);
}
console.log("parameter", apply(row), total);
const alias = row;
console.log("alias", alias === row, alias[1] === callback, alias[1](4));
const read = [() => total, () => total + 1] as const;
console.log("two-functions", read[0](), read[1]());
