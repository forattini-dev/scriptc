// @rust-only
// @no-engine
import type { Choice } from "./module.ts";
async function main(): Promise<void> {
  const ns = await import("./module.ts");
  const other = await import("./barrel.ts");
  const held = ns.rows;
  const row = held[0]!;
  console.log("exports", held === ns.rows, held === other.rows, row === ns.current, ns.same === other.same);
  row.count = 4;
  row.tags.push("second");
  row.values.text = "changed";
  console.log("mutations", ns.rows[0]!.count, `${ns.rows[0]!.tags.join(",")}`, `${ns.rows[0]!.values.text}`);
  console.log("argument identity", ns.same(held) === held, ns.optional(row) === row, row.count);
  console.log("optional", ns.optional() === undefined, ns.optional(undefined) === undefined, ns.optionalArray() === undefined);
  console.log("optional array", ns.optionalArray(held) === held, ns.optional({ count: 7, tags: [], values: {} })!.count);
  console.log("returns", ns.maybe(true) === row, ns.maybe(false) === null, ns.empty() === null);
  const laterRow = await ns.later(true);
  const laterNull = await ns.later(false);
  const laterRows = await ns.laterArray();
  console.log("async", laterRow === row, laterNull === null, laterRows === held);
  held.push({ count: 9, tags: ["last"], values: { nil: null } });
  console.log("push", ns.rows.length as number, ns.rows[1]!.count, ns.rows[1] === held[1]);
  console.log("nullable array", ns.nullableArray(held) === held, ns.nullableArray(null) === null, ns.nullableArray(undefined) === undefined);
  const sparse = ns.sparse as number[];
  console.log("sparse", sparse === ns.sparse, sparse.length, 1 in sparse, sparse[1] === undefined, JSON.stringify(sparse));
  const oldNumbers = ns.numbers;
  ns.replace();
  console.log("live", ns.current === null, other.current === null, ns.numbers === oldNumbers, `${ns.numbers[0]}`, `${oldNumbers[0]}`);
  ns.clear();
  console.log("clear", ns.current === undefined, other.current === undefined);
  ns.restore();
  console.log("restore", ns.current === row);
  const before = ns.choice;
  if (before?.kind === "left") before.count = 6;
  console.log("choice", ns.choice === before, JSON.stringify(other.choice as Choice | null));
  const after = ns.choose({ kind: "right", label: "kept" });
  console.log("choice changed", after === ns.choice, after === other.choice, JSON.stringify(after as Choice | null));
  console.log("choice null", ns.choose(null) === null, ns.choice === null);
  const optional: any = ns.optional;
  const optionalArray: any = ns.optionalArray;
  console.log("arity", optional.length, optionalArray.length);
}
await main();
export {};
