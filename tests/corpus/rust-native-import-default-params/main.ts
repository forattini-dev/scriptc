// @rust-only
// @no-engine
import { tail as staticTail } from "./module.ts";
const staticFunction: any = staticTail;
console.log("static arity before import", staticFunction.length as number);
async function main(): Promise<void> {
  const ns = await import("./module.ts");
  const other = await import("./barrel.ts");
  console.log("scalar", ns.scalar(), ns.scalar(undefined), ns.scalar(null), `[${ns.scalar("")}]`);
  console.log("falsy", ns.number(), ns.number(0), ns.boolean(), ns.boolean(false));
  ns.replace();
  console.log("live default", ns.scalar(), ns.tail("prefix:"), ns.middle(undefined, ":last"));
  const optional: any = ns.optional;
  const tail: any = ns.tail;
  const middle: any = ns.middle;
  const fresh: any = ns.fresh;
  const named: any = ns.default;
  console.log("arity", optional.length, tail.length, middle.length, fresh.length, named.length, named.name);
  console.log("aliases", ns.tail === other.tail, ns.fresh === other.fresh, ns.default === other.named);
  console.log("static arity after import", staticFunction.length as number, tail.length);
  const overloaded: any = ns.overloaded;
  console.log("overloaded", ns.overloaded(), ns.overloaded("given"), overloaded.length);
  tail.label = "kept";
  const alias: any = other.tail;
  console.log("properties", alias.label as string, tail.length);
  const first = ns.fresh();
  const second = ns.fresh();
  console.log("fresh", first !== second, first.count, second.count);
  const destructured: any = ns.destructured;
  console.log("destructured", ns.destructured(), ns.destructured(undefined), ns.destructured({ count: 9 }), destructured.length);
  console.log("shared", ns.shared() === ns.sharedRow, ns.sharedRow.count);
  const firstArray = ns.array() as number[];
  const secondArray = ns.array() as number[];
  console.log("arrays", firstArray !== secondArray, JSON.stringify(firstArray), JSON.stringify(secondArray));
  ns.reset();
  console.log("order", ns.ordered(), `${ns.trace.join(",")}`);
  ns.reset();
  console.log("arguments first", ns.ordered(undefined, ns.argument()), `${ns.trace.join(",")}`);
  ns.reset();
  console.log("surplus arguments", tail("prefix:", undefined, ns.argument()) as string, `${ns.trace.join(",")}`);
  ns.reset();
  try { ns.throwing(); } catch (error) { if (error instanceof Error) console.log("throw", error.message, `${ns.trace.join(",")}`, ns.bodyStarts); }
  ns.reset();
  const pending = ns.later();
  console.log("async started", `${ns.trace.join(",")}`);
  const result = await pending;
  console.log("async result", result);
  ns.reset();
  const rejected = ns.laterThrowing();
  console.log("async rejection returned", `${ns.trace.join(",")}`);
  try { await rejected; } catch (error) { if (error instanceof Error) console.log("async throw", error.message, ns.bodyStarts); }
}
await main();
export {};
