// @rust-only
// @no-engine
let memo: string | null | undefined;
console.log("initial", memo === undefined);
memo = null;
console.log("null", memo === null);
memo = "cached";
console.log("value", memo);
function counter(): () => number {
  let value: number | undefined;
  return () => { if (value === undefined) value = 0; value = value + 1; return value; };
}
const next = counter();
console.log("counter", next(), next());
function optional(): void {
  let items: number[] | undefined;
  let record: { value: number } | undefined;
  console.log("containers", items === undefined, record === undefined);
  items = [4];
  record = { value: 7 };
  console.log("assigned", items[0], record.value);
}
optional();
