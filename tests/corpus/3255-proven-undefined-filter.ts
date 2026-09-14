// @no-engine
// Redcode schema/options.ts: a written guard must prove the retained arm.
const select = (...items: readonly (Record<string, string> | undefined)[]): Record<string, string>[] =>
  items.filter((item): item is Record<string, string> => item !== undefined);
const original: Record<string, string> = { label: "before" };
const selected = select(undefined, original, undefined);
selected[0].label = "after";
console.log(select().length, selected.length, original.label, selected[0] === original);
const values: (string | undefined)[] = [undefined, "a", "", undefined, "b"];
console.log(values.filter((value): value is string => value !== undefined).join("/"));
console.log(values.filter((value): value is string => undefined !== value).join("/"));
const mixed: (number | null | undefined)[] = [0, null, 1, undefined, 2];
console.log(mixed.filter((value): value is number => value != undefined).join(","));
console.log(mixed.filter(function(value): value is number { return (undefined) != (value); }).join(","));
const nullable: (string | null)[] = [null, "a", "b"];
console.log(nullable.filter((value): value is string => (value) !== (null)).join(","));
console.log(nullable.filter((value): value is string => (null) !== (value)).join(","));
const inferred = values.filter(value => value !== undefined);
console.log(inferred.join("/"));
const payload: Record<string, unknown> = { count: 7 };
const records: (Record<string, unknown> | undefined)[] = [undefined, payload];
const retained = records.filter((item): item is Record<string, unknown> => item !== undefined);
retained[0].count = 9;
console.log(retained.length, retained[0] === payload, payload.count);
// The same constant proof is used by ordinary loose comparisons.
function nullish(value: string | null | undefined): void {
  console.log(value == undefined, undefined != value);
}
nullish(undefined); nullish(null); nullish(""); nullish("x");
function shadow(undefined: string, value: string): boolean { return value == undefined; }
console.log(shadow("x", "x"), shadow("x", "y"));
