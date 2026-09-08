// @no-engine
// @rust-only
// A module job starts only after recursively queued microtasks drain.
import { value as staticallyRead } from "./static.ts";
const first = import("./module.ts");
const alias = first;
first.then(ns => console.log("first", ns.value));
queueMicrotask(() => {
  console.log("microtask 1");
  queueMicrotask(() => console.log("microtask 2"));
});
async function main(): Promise<void> {
  const ns = await alias;
  console.log("units", ns.empty === null, ns.missing === undefined, ns.__value);
  const { value } = ns;
  console.log("destructure", value);
  console.log("static", (await import("./static.ts")).value === staticallyRead);
  const cached = import("./module.ts");
  cached.then(value => console.log("cached", value === ns));
  queueMicrotask(() => {
    console.log("cached microtask 1");
    queueMicrotask(() => console.log("cached microtask 2"));
  });
  await cached;
}
main();
console.log("entry");
