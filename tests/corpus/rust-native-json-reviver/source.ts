// @rust-only
// @no-engine
// @ts-nocheck
export {};
const read = JSON.parse;
const write = JSON.stringify;
let trace = "";
const parsed = read(' {"z":1.00e+02,"2":true,"a":[-0,null,"\\u0061"],"z":9007199254740993} ', (key, value, context) => {
  trace = trace + key + ":" + (context.source === undefined ? "container" : context.source) + ";";
  return value;
});
console.log("trace", trace);
console.log("parsed", parsed.z === 9007199254740992, parsed.a[2] === "a", String(write(parsed)));
console.log("root", String(read(" 1.00E+02 ", (key, value, context) => key + "|" + context.source)));
console.log("one", read("1", value => value) === "");
console.log("two", read("1", (key: string, value: number) => value + 2) === 3);
console.log("none", read("1", () => 7) === 7);
console.log("delete-root", read("1", () => undefined) === undefined);
console.log("null-root", read("1", () => null) === null);
let raw = '"' + read('"\\ud800"') + '"';
console.log("surrogate", read(raw, (key, value, context) => context.source) === raw);
console.log("emoji", read('"😀"', (key, value, context) => context.source) === '"😀"');
console.log("escape", read('"\\ud800"', (key, value, context) => context.source) === '"\\ud800"');
let big = read("9007199254740993", (key, value, context) => BigInt(context.source));
console.log("bigint", big === 9007199254740993n);
