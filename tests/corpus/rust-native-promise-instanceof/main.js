// Mirrors zod's `isAsync` helper: an untyped JavaScript value checked
// against the standard Promise constructor.
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

function report(label, value) {
  console.log(label, isAsync(value));
}

report("promise", Promise.resolve(1));
report("async", (async () => "value")());
report("number", 42);
report("string", "text");
report("object", { then() {} });
report("array", [1, 2]);
report("null", null);
report("undefined", undefined);

let reads = 0;
function next() {
  reads += 1;
  return Promise.resolve(reads);
}
console.log(next() instanceof Promise, reads);

async function main() {
  const values = [Promise.resolve("a"), "b"];
  for (const value of values) {
    console.log(value instanceof Promise ? await value : value);
  }
}
main();
