// @no-engine
// @rust-only
// Local import() evaluates lazily once and shares a live module namespace.
async function main(): Promise<void> {
  console.log("before");
  const first = import("./counter.ts");
  const second = import("./counter.ts");
  console.log("distinct promises", first !== second);
  queueMicrotask(() => console.log("microtask"));
  const a = await first;
  const b = await second;
  console.log("same namespace", a === b, a.count);
  a.increment();
  console.log("live", b.count);
  const asserted = a as {count: number};
  a.increment();
  console.log("cast live", asserted.count, asserted === a);
  const c = await import("./counter.ts");
  console.log("cached", c === a, c.count);
}
void main();
console.log("entry");
