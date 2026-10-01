// @rust-only
// @no-engine
// Runtime keys convert after the spread and before values, without a static name.
let events = "";
function source(): { [key: string]: number } {
  events += "source;";
  return { middle: 2, first: 1 };
}
function key(value: any): any {
  events += "key;";
  return value;
}
function value(): number { events += "value;"; return 7; }
function build(input: any): { [key: string]: number } {
  return { ...source(), [key(input)]: value(), after: 8 };
}
for (const input of ["first", 42]) {
  events = "";
  const result = build(input);
  console.log(Object.keys(result).join(","), JSON.stringify(result), events);
}
