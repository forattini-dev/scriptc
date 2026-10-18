let trace = "";
function text(mark: string): string { trace = trace + mark; return mark; }
function fail(): string { trace = trace + "!"; throw new Error("stop"); }
type Item = { a: string; b?: string; c?: string };
try {
  const unused: Item = { a: text("A"), ...(true ? { b: fail(), c: text("wrong") } : {}), c: text("also-wrong") };
  console.log(unused.a);
} catch {
  console.log("caught", trace);
}
const good: Item = { a: text("B"), ...(false ? { b: fail() } : { c: text("C") }) };
console.log("success", trace, Object.hasOwn(good, "b"), Object.hasOwn(good, "c"));
