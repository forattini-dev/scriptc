// @rust-only
// @no-engine
const events: string[] = [];
function mark(label: string): number { events.push(label); return events.length; }
async function later(label: string): Promise<number> { events.push(label); return events.length; }
async function mutate(values: number[]): Promise<number> { values[0] = 99; return 8; }
async function fail(): Promise<number> { events.push("reject"); throw new Error("expected"); }
async function main(): Promise<void> {
  const values: unknown[] = [mark("before"), await later("await"), mark("after")];
  values.push("tail");
  console.log("values", JSON.stringify(values), events.join(","));
  const source: number[] = [7];
  const nested: unknown[] = [[mark("nested"), await later("inner")], ...source, await later("last")];
  nested.push("end");
  const inner = nested[0];
  if (Array.isArray(inner)) inner.push("inner tail");
  console.log("nested", JSON.stringify(nested), events.join(","));
  const snapshot: unknown[] = [...source, await mutate(source)];
  console.log("spread snapshot", JSON.stringify(snapshot), source[0]);
  const boxed: unknown = await later("boxed");
  console.log("boxed", boxed);
  try {
    const protectedValues: unknown[] = [mark("try"), await later("protected"), mark("done")];
    protectedValues.push("ok");
    console.log("protected", JSON.stringify(protectedValues));
  } catch (error) { console.log("unexpected", String(error)); }
  try {
    const rejected: unknown[] = [mark("start failure"), await fail(), mark("must not run")];
    console.log("missed rejection", JSON.stringify(rejected));
  } catch (error) { console.log("caught", error instanceof Error); }
  console.log("events", events.join(","));
}
main();
