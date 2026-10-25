// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace = "";
const value = JSON.parse('{"keep":1,"drop":2,"a":[10,20,30],"__proto__":{"safe":true}}', function (key, value, context) {
  trace = trace + key + ";";
  if (key === "drop" || key === "1") return undefined;
  if (key === "0") return 11;
  if (key === "safe") return false;
  return value;
});
console.log("trace", trace);
console.log("object", Object.keys(value).join(","), Object.hasOwn(value, "drop"), value.drop === undefined);
console.log("array", value.a.length === 3, value.a[0] === 11, value.a[1] === undefined, Object.hasOwn(value.a, "1"), Object.hasOwn(value.a, "length"), Object.keys(value.a).join(","));
console.log("prototype", Object.hasOwn(value, "__proto__"), value["__proto__"].safe === false);
console.log("json", String(JSON.stringify(value)));
