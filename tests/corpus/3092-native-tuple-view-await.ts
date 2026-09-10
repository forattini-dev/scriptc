// @rust-only
// @no-engine
let order = "";
async function part(value: string): Promise<string> { order += value; await Promise.resolve(); return value; }
async function main(): Promise<void> {
  const tuple: [string, string] = [await part("a"), await part("b")];
  function accept(value: string[]): string[] { return value; }
  const view = accept(tuple);
  await Promise.resolve();
  view.push("c");
  let calls = 0;
  function current(): [string, string] { calls++; return tuple; }
  console.log("length", current().length, calls, order);
  function separator(): string { view[1] = "changed"; return ":"; }
  console.log("join", tuple.join(separator()));
  console.log("identity", view === tuple);
  const before = [...tuple];
  view[0] = "updated";
  console.log("spread", before.join(","), tuple.join(","));
  for (const value of current()) console.log("item", value);
  console.log("calls", calls);
}
await main();
export {};
