// @no-engine
let events = "";
function fallback() {
  events += "fallback,";
  return (value: string, options?: { prefix?: string }): string | null => (options?.prefix ?? "default:") + value;
}
function choose(value?: ((name: string) => string | null) | null) {
  function left() { events += "left,"; return value; }
  return left() ?? fallback();
}
console.log(choose(name => "custom:" + name)("one"), events);
events = "";
console.log(choose()("two"), events);
events = "";
console.log(choose(null)("three", { prefix: "explicit:" }), events);
