// @rust-only
// @no-engine
import { failure } from "./state.ts";
function samePromise(left: Promise<void>, right: Promise<void>): boolean {
  return left === right;
}
function sameOptionalPromise(left: Promise<void>, right: Promise<void>, enabled: boolean): boolean {
  const a = enabled ? left : undefined;
  const b = enabled ? right : undefined;
  return a === b;
}
async function readDynamic(value: unknown): Promise<void> {
  console.log("await dynamic", (await value) as number);
}
async function main(): Promise<void> {
  const ns = await import("./module.ts");
  console.log("function identity", ns.add === ns.aliasAdd);
  const first = ns.add(2);
  const second = ns.aliasAdd(3);
  console.log("distinct", first !== second);
  console.log("answers", await first, await second);
  console.log("shared", ns.cached() === ns.cached());
  console.log("typed shared", samePromise(ns.cachedDone(), ns.cachedDone()));
  console.log("union shared", sameOptionalPromise(ns.cachedDone(), ns.cachedDone(), true));
  console.log("cached", await ns.cached());
  const dynamic: any = ns.cached();
  dynamic.then((value: number) => { console.log("dynamic then", value); });
  ns.cached().then(value => { console.log("then", value as number); });
  readDynamic(dynamic);
  Promise.resolve().then(() => { console.log("tick"); });
  await Promise.resolve();
  console.log("after tick");
  console.log("chain", (await ns.cached().then(value => (value as number) + 2)) as number);
  console.log("recovered", (await ns.fail().catch(() => 9)) as number);
  console.log("finally", (await ns.cached().finally(() => { console.log("cleanup"); })) as number);
  await ns.done();
  console.log("void complete");
  console.log("primitives", await ns.text(), await ns.flag());
  try { await ns.fail(); } catch (error) {
    console.log("caught", (error as Error).message);
    console.log("reason identity", (error as Error) === failure);
  }
}
main();
console.log("entry");
export {};
