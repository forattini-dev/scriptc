// @rust-only
// @no-engine
export {};
function test(value: any): void {
  console.log("nullish", value == null, value != null, null == value, null != value);
}
test(null); test(undefined); test(false); test(0); test(""); test("null");
test(Number("bad")); test(0n); test({value: 1}); test([1]);
let reads = 0;
function read(): any { reads++; return undefined; }
console.log("effects", read() == null, null != read(), reads);
function nothing(): void { reads++; }
console.log("void", nothing() == null, reads);
const record: {value: number | null | undefined} = {value: 3};
const alias = record;
function clear(): number { alias.value = undefined; return 1; }
console.log("present", record.value != null);
console.log("changed", clear(), record.value == null);
record.value = 0;
console.log("zero", record.value != null);
function format(value?: number): string {
  if (value == null) return "missing";
  return String(value);
}
console.log("guard", format(), format(0), format(12));
let callback: (() => void) | undefined = () => {};
console.log("callback", callback != null);
callback = undefined;
console.log("absent", callback == null);
function shadow(undefined: number): boolean { return undefined == null; }
console.log("shadow", shadow(1));
