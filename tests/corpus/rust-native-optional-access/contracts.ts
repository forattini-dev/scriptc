// @rust-only
// @no-engine
export {};
type Counters = Record<string, number>;
function increased(current: Counters | undefined, previous: Counters | undefined, key: string): boolean {
  return (current?.[key] ?? 0) > (previous?.[key] ?? 0);
}
console.log(increased({hits: 2}, {hits: 1}, "hits"), increased(undefined, {hits: 1}, "hits"));
console.log(increased({hits: 2}, undefined, "hits"), increased({}, {}, "hits"));
function read(value: Counters | null | undefined, key: string): number | undefined { return value?.[key]; }
console.log(read({x: 4}, "x"), read({}, "x"), read(null, "x"), read(undefined, "x"));
const missing = read({}, "missing");
console.log(missing);
const numeric: Record<number, string> = {0: "zero", 2: "two"};
const absent = numeric?.[99];
const found = numeric?.[-0];
console.log(absent);
console.log(found);
function captures(value: Counters | undefined): () => number | undefined {
  const saved = value?.["hits"];
  return () => saved;
}
console.log(captures({hits: 7})(), captures({})(), captures(undefined)());
type Options = {enabled?: boolean; title?: string; value?: number};
function options(value: Options | undefined): void {
  console.log(value?.enabled ?? true);
  console.log((value?.title ?? "default") + "!");
  console.log((value?.value ?? 9) + 1);
}
options({enabled: false, title: "", value: 0});
options(undefined);
function optionalNumber(value: number | null | undefined): number { return (value ?? 3) * 2; }
console.log(optionalNumber(0), optionalNumber(-0), optionalNumber(null), optionalNumber(undefined));
function nan(value: number | undefined): boolean { const n = value ?? 0; return n !== n; }
console.log(nan(0 / 0), nan(undefined));
