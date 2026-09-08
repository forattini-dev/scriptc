// @rust-only
// @no-engine
import { state as staticState } from "./module.ts";
import type { Event } from "./module.ts";
function event(value: unknown): Event { return value as Event; }
function same(left: unknown, right: unknown): boolean { return left === right; }
async function main(): Promise<void> {
  const ns = await import("./module.ts");
  const first = event(ns.state);
  console.log("exports", first === staticState, ns.state === ns.aliasState);
  first.bytes = 11;
  console.log("export mutation", ns.read(), event(ns.state).bytes);
  console.log("echo", event(ns.echo(first)) === first);
  const pending = ns.update(first);
  console.log("before await", first.bytes);
  const completed = await pending;
  const result = event(completed);
  console.log("after await", result === first, first.bytes, first.extra as string);
  ns.replace();
  console.log("rebound", event(ns.state) === staticState, event(ns.default) === first, first.bytes, staticState.bytes);

  // A structurally compatible object need not have the parameter's shape.
  const compatible = { collection: "other", bytes: 20, label: "retained" };
  const compatibleCompleted = await ns.update(compatible);
  const compatibleResult = event(compatibleCompleted);
  console.log("compatible", compatible.bytes, same(compatibleResult, compatible), compatible.label);
  compatibleResult.bytes = 25;
  console.log("compatible write", compatible.bytes);
  const absent: Event = { collection: "optional" };
  const absentCompleted = await ns.update(absent);
  console.log("optional", event(absentCompleted) === absent, absent.bytes);
}
main();
export {};
