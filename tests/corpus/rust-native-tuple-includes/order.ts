let trace = "";
const values: readonly [number, number, number] = [1, 2, 3];
function receiver(): readonly [number, number, number] {
  trace = trace + "r";
  return values;
}
function search(): number {
  trace = trace + "s";
  return 2;
}
function offset(): number {
  trace = trace + "i";
  return -2;
}
function extra(): number {
  trace = trace + "x";
  return 99;
}
// @ts-expect-error Extra arguments still evaluate before the search.
console.log(receiver().includes(search(), offset(), extra()), trace);
trace = "";
// @ts-expect-error Assertions must not erase the runtime offset conversion.
console.log(receiver().includes(search(), "2" as number), trace);
trace = "";
// @ts-expect-error Omitted search still evaluates the receiver once.
console.log(receiver().includes(), trace);
trace = "";
function stop(): number {
  trace = trace + "!";
  throw new Error("stop");
}
try {
  // @ts-expect-error An extra argument can throw before a successful search.
  receiver().includes(search(), offset(), stop());
} catch (error) {
  console.log((error as Error).message);
  console.log(trace);
}
function make(): readonly [string, string] & { includes(value: string | number): boolean } {
  return ["one", "two"] as const;
}
const view = make();
console.log(view.includes(1), view.includes("two"));
