// @no-engine
// Reduced from Redcode packages/llm/src/schema/options.ts: readonly
// arrays of optional dictionaries, carried by a recursive function value.
const merge = (...items: readonly (Record<string, string> | undefined)[]): Record<string, string> | undefined => {
  const result: Record<string, string> = {};
  let found = false;
  for (const item of items) {
    if (item === undefined) continue;
    for (const key of Object.keys(item)) { result[key] = item[key]; found = true; }
  }
  return found ? result : undefined;
};
console.log(merge() === undefined, merge(undefined) === undefined);
const result = merge(undefined, { a: "first" }, { a: "last", b: "second" });
if (result !== undefined) console.log(result.a, result.b);
const recurse = (depth: number, ...items: readonly string[]): string =>
  depth === 0 ? items.join("/") : recurse(depth - 1, "step", ...items);
console.log(recurse(2, "end"));
