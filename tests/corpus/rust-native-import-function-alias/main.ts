// @rust-only
// @no-engine
import { stored } from "./aliases.ts";
const ns = await import("./module.ts");
const { fresh: topFresh, default: topDefault } = ns;
const topAlias = topFresh;
function invokeTop(): number { return topAlias().count; }
console.log("top", invokeTop(), topDefault().count);
async function main(): Promise<void> {
  const { fresh, twice, array, later, fail } = await import("./module.ts");
  const alias = fresh;
  const aliasAgain = alias;
  const memberAlias = ns.fresh;
  const elementAlias = ns["fresh"];
  const annotated: typeof ns.fresh = aliasAgain;
  const asserted = ((aliasAgain as typeof ns.fresh)!);
  const checked = asserted satisfies typeof ns.fresh;
  const other = await import("./barrel.ts");
  const { fresh: reexported } = other;
  console.log("identity", fresh === aliasAgain, fresh === memberAlias, fresh === elementAlias, fresh === reexported, topFresh === fresh);
  const reflection: any = aliasAgain;
  reflection.label = "kept";
  const otherReflection: any = reexported;
  console.log("properties", otherReflection.label as string, reflection.name, reflection.length);
  console.log("defaults", fresh().count, alias().count, annotated().count);
  console.log("wrappers", checked().count, stored().count, stored === fresh);
  const row = ns.shared;
  const result = aliasAgain(row);
  console.log("record", result === row, result === ns.shared, result.count);
  const values = [1];
  const returned = array(values);
  console.log("array", returned === values, JSON.stringify(values));
  let mutable = fresh;
  mutable = twice;
  console.log("mutable", mutable().count, fresh().count);
  var hoisted = fresh;
  console.log("var", hoisted().count);
  const captured = (): number => aliasAgain().count;
  console.log("captured", captured());
  {
    const alias = twice;
    console.log("shadow", alias().count);
  }
  console.log("outer", alias().count);
  const asyncAlias = later;
  const settled = await asyncAlias(row);
  console.log("async", settled === row, settled.count);
  const failAlias = fail;
  try { failAlias(); } catch (error) { if (error instanceof Error) console.log("throw", error.message); }
  console.log("calls", ns.calls);
  await import("./module.ts").then(namespace => {
    const { fresh: callback } = namespace;
    const callbackAlias = callback;
    console.log("then", callbackAlias === fresh, callbackAlias().count);
  });
}
await main();
export {};
