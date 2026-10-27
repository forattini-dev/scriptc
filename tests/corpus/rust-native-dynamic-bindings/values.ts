// @rust-only
// @no-engine
// @ts-nocheck
export {};
const data: any = JSON.parse('{"nested":{"value":3},"count":7,"nothing":null}');
const { count: renamed, nested, missing, nothing } = data;
console.log("values", Number(renamed), missing === undefined, nothing === null);
console.log("identity", nested === data.nested);
nested.value = 9;
console.log("alias", Number(data.nested.value));
function capture(source: any): () => any {
  const { nested: original } = source;
  source.nested = { value: 42 };
  return () => original;
}
const read = capture(data);
console.log("capture", Number(read().value), Number(data.nested.value), read() === nested);
let { count } = data;
function replaceSnapshot(): void { count = 18; }
count = 11;
console.log("mutable", Number(count), Number(data.count));
replaceSnapshot();
console.log("mutable-capture", Number(count), Number(data.count));
function callable(): void {
  const source: any = { fn: (value: number): number => value + 1 };
  const { fn } = source;
  console.log("callable", Number(fn(4)), fn === source.fn);
}
callable();
