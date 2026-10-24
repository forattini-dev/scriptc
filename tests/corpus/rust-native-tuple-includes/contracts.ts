type EventKind = "birth" | "activity" | "death";
export const kinds = ["birth", "activity", "death"] as const as readonly [
  "birth", "activity", "death"
] & { includes(searchElement: EventKind | "refusal" | "daemon-start"): boolean };
const alias = kinds;
function contains(event: EventKind | "refusal" | "daemon-start"): boolean {
  return alias.includes(event);
}
console.log(contains("birth"), contains("death"), contains("refusal"));
console.log(kinds.length, kinds[0], alias[2], kinds.join("/"));
console.log(alias === kinds);
const plain: readonly [string, string, string] = alias;
console.log(plain.includes("activity"), plain.includes("missing"));
const long = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] as const;
console.log(long.includes("10", 10), long.includes("11", 11), long.includes("10", 11));
const numbers: readonly [number, number, number, number] = [(0 / 0), -0, 4, (1 / 0)];
console.log(numbers.includes((0 / 0)), numbers.includes(0), numbers.includes(-0), numbers.includes((-1 / 0)));
console.log(numbers.includes((0 / 0), (0 / 0)), numbers.includes(4, 2.9), numbers.includes(4, 3));
console.log(numbers.includes(4, -2.9), numbers.includes((0 / 0), (-1 / 0)), numbers.includes((1 / 0), (1 / 0)));
console.log(numbers.includes(4, 200), numbers.includes(4, -200), numbers.includes(4, undefined));
const mixed: readonly [number | string, boolean, string] = [1, false, "1"];
// @ts-expect-error A missing value is still a valid runtime search.
console.log(mixed.includes(1), mixed.includes("1"), mixed.includes(true), mixed.includes(undefined));
const empty: readonly [] = [];
// @ts-expect-error Runtime includes permits an omitted search value.
console.log(empty.includes());
const missing: readonly [number | undefined] = [undefined];
// @ts-expect-error Omitted search means undefined.
console.log(missing.includes());
console.log(missing.includes(undefined), missing.includes(null as unknown as number));
