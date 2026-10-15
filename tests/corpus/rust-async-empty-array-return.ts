// @rust-only
// @no-engine
type Row = { id: string; reason: string };
const trace: string[] = [];
function condition(label: string, value: boolean): boolean { trace.push(label); return value; }
async function plan(skip: boolean): Promise<Row[]> {
  if (skip) return [];
  return [{ id: "node", reason: "selected" }];
}
async function choice(first: boolean, second: boolean): Promise<Row[]> {
  return condition("first", first) ? [] : condition("second", second) ? [] : [];
}
async function nullable(skip: boolean): Promise<Row[] | null> {
  if (skip) return null;
  return [];
}
async function generic<T>(): Promise<T[]> { return []; }
async function nested(): Promise<Row[][]> { return [[], []]; }
async function strings(): Promise<string[]> { return []; }
async function readonlyRows(): Promise<readonly Row[]> { return (([])); }
const arrow = async (): Promise<Row[]> => [];
async function withFinally(): Promise<Row[]> {
  try { return []; } finally { trace.push("finally"); }
}
async function shared(rows: Row[]): Promise<Row[]> { return rows; }
async function adopted(skip: boolean): Promise<Row[]> { return plan(skip); }
async function main(): Promise<void> {
  const empty = await plan(true);
  const another = await plan(true);
  const filled = await plan(false);
  empty.push({ id: "rust", reason: "fresh" });
  console.log("plan", JSON.stringify(empty), JSON.stringify(another), JSON.stringify(filled), empty !== another);
  const choices = [await choice(true, false), await choice(false, true), await choice(false, false)];
  console.log("choices", JSON.stringify(choices), trace.join(","));
  const missing = await nullable(true);
  const present = await nullable(false);
  console.log("nullable", missing === null, present === null ? -1 : present.length);
  const genericRows = await generic<Row>();
  genericRows.push({ id: "generic", reason: "typed" });
  const nestedRows = await nested();
  nestedRows[0]!.push({ id: "nested", reason: "typed" });
  console.log("generic", JSON.stringify(genericRows), JSON.stringify(nestedRows));
  const text = await strings();
  text.push("ok");
  const frozen = await readonlyRows();
  const fromArrow = await arrow();
  console.log("other", text.join(","), frozen.length, fromArrow.length);
  const finalized = await withFinally();
  console.log("finally", finalized.length, trace.join(","));
  const same = await shared(filled);
  same.push({ id: "shared", reason: "kept" });
  console.log("identity", same === filled, JSON.stringify(filled));
  const adoptedEmpty = await adopted(true);
  const adoptedFilled = await adopted(false);
  console.log("adopted", adoptedEmpty.length, JSON.stringify(adoptedFilled));
}
await main();
export {};
