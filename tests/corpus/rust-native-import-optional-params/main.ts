// @rust-only
// @no-engine
async function calls(): Promise<void> {
  const ns = await import("./module.ts");
  console.log("strings", ns.greet(), ns.greet(undefined), ns.greet("TS"), ns.greet(""));
  console.log("numbers", ns.count(), ns.count(undefined), ns.count(0), ns.count(4));
  console.log("booleans", ns.flag(), ns.flag(undefined), ns.flag(false), ns.flag(true));
  console.log("nullable", ns.nullable(), ns.nullable(undefined), ns.nullable(null), ns.nullable("value"));
  console.log("pair", ns.pair("hello"), ns.pair("hello", undefined), ns.pair("hello", "?"));
  console.log("mixed", ns.optionalBeforeRequired(undefined), ns.optionalBeforeRequired("set", 2));
  const fn: any = ns.greet;
  console.log("metadata", fn.name, fn.length);
  const pair: any = ns.pair; console.log("pair arity", pair.length);
  const asyncFn: any = ns.later; console.log("async metadata", asyncFn.name, asyncFn.length);
  const dynamic: any = ns.count;
  console.log("dynamic calls", dynamic(), dynamic(undefined), dynamic(5), dynamic(5, 6));
  const text = await ns.later(); const given = await ns.later("provided");
  console.log("async", text, given);
  try { ns.fail(); } catch (error) { console.log("throw", (error as Error).message); }
  try { await ns.reject(); } catch (error) { console.log("reject", (error as Error).message); }
}
async function identity(): Promise<void> {
  const ns = await import("./module.ts");
  const again = await import("./module.ts");
  const barrel = await import("./barrel.ts");
  const defaults = await import("./default.ts");
  console.log("identity", ns === again, ns.greet === ns.alias, ns.greet === barrel.greet, ns.greet === barrel.renamed);
  const fn: any = ns.greet; fn.label = "kept";
  const alias: any = barrel.renamed;
  console.log("properties", alias.label, alias.name, alias.length, alias());
  alias.label = "updated"; console.log("mutated", fn.label);
  const defaultFn: any = defaults.default;
  console.log("default export", defaultFn.name, defaultFn.length, defaultFn(), defaultFn(undefined), defaultFn("provided"));
  console.log("default identity", defaults.default === barrel.forwarded);
}
await calls(); await identity();
export {};
