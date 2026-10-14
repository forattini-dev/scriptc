// @no-engine
type Source = { fallback: string; reason?: undefined } | { fallback: null; reason: string };
type Result = { before: string; fallback: string | null; reason?: string; only?: string; after: string };
let trace = "";
function source(missing: boolean): Source {
  trace += "S";
  return missing ? { fallback: null, reason: "missing" } : { fallback: "rest" };
}
function marker(value: string): string { trace += value; return value; }
function merge(missing: boolean): Result {
  return { before: marker("B"), ...source(missing), ...(missing ? { only: "one" } : {}), after: marker("A") };
}
for (const missing of [false, true]) {
  trace = "";
  const result = merge(missing);
  console.log(trace, JSON.stringify(result), Object.keys(result).join(","), Object.hasOwn(result, "reason"));
}
const explicitUndefined: Source = { fallback: "rest", reason: undefined };
const copied = { ...explicitUndefined, after: "tail" };
console.log(Object.keys(copied).join(","), Object.hasOwn(copied, "reason"), JSON.stringify(copied));
const mutable = { value: 1 };
function selected(flag: boolean): { value: number } | { value: string } { return flag ? mutable : { value: "text" }; }
function mutate(): number { mutable.value = 7; return 7; }
const snapshot: { value: number | string; mutate: number } = { ...selected(true), mutate: mutate() };
console.log(snapshot.value, mutable.value, snapshot.mutate);
function counts(rc: boolean): { major: number; minor: number; patch: number; rc?: number } {
  return { major: 0, minor: 0, patch: 0, ...(rc ? { rc: 1 } : {}) };
}
console.log(JSON.stringify(counts(true)), JSON.stringify(counts(false)));
