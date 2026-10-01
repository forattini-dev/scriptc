// @rust-only
// @no-engine
// An array iterator yields undefined for holes and observes live length.
const keys: string[] = ["a"];
keys.length = 2;
let evaluations = 0;
function source(): string[] {
  evaluations++;
  return keys;
}
const values: Record<string, string> = { a: "A", b: "B", undefined: "U" };
const written: Record<string, string> = {};
let visits = 0;
walk: for (const key of source()) {
  console.log("visit", typeof key, values[key]);
  written[key] = typeof key;
  visits++;
  if (visits === 1) {
    keys.push("b");
    continue walk;
  }
}
console.log("iterator", evaluations, visits, Object.keys(written).join(","));
console.log("values", written.a, written.undefined, written.b);
const numbers: number[] = [4];
numbers.length = 2;
for (const value of numbers) console.log("number", typeof value, String(value));
const rows: { id: number }[] = [{ id: 5 }];
rows.length = 2;
for (const row of rows) {
  try {
    console.log("row", row.id);
  } catch (error) {
    console.log(error instanceof TypeError, (error as Error).message);
  }
}
