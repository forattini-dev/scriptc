// @rust-only
// @no-engine
const write = JSON.stringify;
let order = "";
const callback = (key: string, value: any): any => {
  order = order + "[" + key + "]";
  if (key === "drop") return undefined;
  if (key === "value") return 7;
  return value;
};
const result = write({value: 1, drop: 2, nested: {value: 3}}, callback);
console.log("replacer", result === '{"value":7,"nested":{"value":7}}', order === "[][value][drop][nested][value]");
console.log("whitelist", write({a: 1, b: 2, nested: {a: 3, b: 4}}, ["nested", "b", "b"]) === '{"nested":{"b":4},"b":2}');
console.log("space", write({a: [1, 2]}, null, 2) === '{\n  "a": [\n    1,\n    2\n  ]\n}');

const live = {a: 1, b: 2};
const change = (key: string, value: any): any => { if (key === "a") live.b = 9; return value; };
console.log("live", write(live, change) === '{"a":1,"b":9}');
