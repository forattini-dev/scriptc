// @rust-only
// @no-engine
export {};
let trace = "";
type Dict = Record<string, number>;
function base(value: Dict | null | undefined): Dict | null | undefined { trace = trace + "b"; return value; }
function key(): string { trace = trace + "k"; return "x"; }
function fallback(): number { trace = trace + "f"; return 9; }
function check(value: Dict | null | undefined): void {
  trace = "";
  const result = base(value)?.[key()] ?? fallback();
  console.log(result, trace);
}
check({x: 2}); check({x: 0}); check({}); check(null); check(undefined);
let selected: Dict | undefined = {x: 5};
function change(): string { trace = trace + "c"; selected = undefined; return "x"; }
trace = "";
console.log(selected?.[change()] ?? 0, trace);
console.log(selected?.[key()] ?? 0, trace);
const holder: {current: Dict | undefined} = {current: undefined};
holder.current = {x: 7};
function clearHolder(): void { holder.current = undefined; }
clearHolder();
console.log(holder.current?.[key()] ?? 0);
function fail(): string { trace = trace + "!"; throw new Error("key"); }
trace = "";
function skipped(value: Dict | undefined): number { return value?.[fail()] ?? 8; }
console.log(skipped(undefined), trace);
try { skipped({x: 1}); } catch (error) {
  console.log((error as Error).message);
  console.log(trace);
}
