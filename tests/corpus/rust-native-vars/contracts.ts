// @rust-only
// @no-engine
function capture(): () => number | undefined {
  const read = (): number | undefined => value;
  console.log("capture before", read() === undefined);
  var value: number | undefined = 4;
  return read;
}
const read = capture();
console.log("capture after", read() === 4);
function defaults(value = 5): number { var value: number; return value; }
console.log("defaults", defaults(), defaults(0));
function reset(): number | undefined {
  var value: number | undefined = 3;
  value = undefined;
  return value;
}
console.log("reset", reset() === undefined);
var pattern = /^[a-z][a-z0-9+.-]*:\/\//i;
console.log("var regex", pattern.test("https://native"), pattern.flags);
var separators = { "=": "data", ":=": { to: "data", typed: true }, ":": "meta" };
console.log("var record", separators === separators);
