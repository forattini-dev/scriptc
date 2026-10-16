// @rust-only
// @no-engine
const optional: (number | undefined)[] = [undefined, 0, 2];
const defaults = optional.map((value = 7, index = 99) => value + index);
console.log("inline-defaults", defaults[0], defaults[1], defaults[2]);
function named(value = 10, index?: number): [number, number] {
  if (index === undefined) return [value, -1];
  return [value, index];
}
const namedMap = new Map(optional.map(named));
console.log("named-defaults", namedMap.size, namedMap.get(10) === 0, namedMap.get(0) === 1);
const pairs: [string, number][] = [["value", 42]];
const widened = new Map<string, number | undefined>(pairs);
console.log("widened", widened.get("value") === 42, widened.get("missing") === undefined);
const literals = new Map([["answer", 42] as const]);
console.log("const-pairs", literals.get("answer") === 42);
const labels = ["a", "b"].map(function (value, index) { return [value, index] as const; });
const byLabel = new Map(labels);
console.log("function-expression", byLabel.get("b") === 1);
const original = ["one"];
console.log("fresh-array", original !== original.map(value => value));
