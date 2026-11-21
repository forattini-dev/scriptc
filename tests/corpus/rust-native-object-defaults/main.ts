// @rust-only
// @no-engine
function fallback(label: string): number { console.log("default", label); return 12; }
function read(source: any): void {
  const { first = fallback("first"), second: renamed = first, nullValue = 99, ...rest } = source;
  console.log("values", String(first), String(renamed), String(nullValue), String(rest.extra));
}
read({ first: 3, second: 0, nullValue: null, extra: "kept" });
read({ first: undefined, extra: "missing" });
function mutable(source: any): void {
  let { count = 2 } = source;
  count = 7;
  console.log("mutable", String(count));
}
mutable({});
function optional(source: { value?: number }): number {
  const { value = fallback("typed") } = source;
  return value;
}
console.log("typed", optional({}), optional({ value: 0 }));
