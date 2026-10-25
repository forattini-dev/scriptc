// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace = "";
const value = JSON.parse('{"a":1,"b":2,"c":0,"nested":{"x":1}}', function (key, value, context) {
  trace = trace + key + ":" + (context.source === undefined ? "missing" : context.source) + ";";
  if (key === "a") { this.b = 8; this.c = -0; this.added = 9; this.nested = {x: 7}; }
  return value;
});
console.log("trace", trace);
console.log("value", String(JSON.stringify(value)));
let arrayTrace = "";
const array = JSON.parse("[1,2,3]", function (key, value, context) {
  arrayTrace = arrayTrace + key + ":" + (context.source === undefined ? "missing" : context.source) + ";";
  if (key === "0") { this.length = 1; this[4] = 5; }
  return value;
});
console.log("array-trace", arrayTrace);
console.log("array", String(JSON.stringify(array)), Object.keys(array).join(","));
let previous;
let fresh = true;
JSON.parse("[1,2]", (key, value, context) => { if (previous === context) fresh = false; previous = context; return value; });
console.log("fresh", fresh);
