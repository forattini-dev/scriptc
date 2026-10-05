// @rust-only
// @no-engine

let evaluations = 0;
function length() {
  evaluations++;
  return 2;
}
const original = new Array(length());
const alias = original;
alias[0] = "a";
console.log("alias", evaluations, original === alias, original.join("|"));
const nested = new Array(original);
console.log("nested", nested.length, nested[0] === original, Array.isArray(nested));
const value = JSON.parse('{"value":7}');
const objectItem = new Array(value);
const other = new Array(value);
console.log("identity", objectItem.length, objectItem[0] === value, objectItem !== other);
let order = "";
function item(text) {
  order += text;
  return JSON.parse('"' + text + '"');
}
const items = new Array(item("a"), item("b"), item("c"));
console.log("order", order, items.join("|"));
