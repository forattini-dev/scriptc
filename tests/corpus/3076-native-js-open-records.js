// @no-engine
// @rust-only
function create() { return {}; }
function put(bucket, key, value) { bucket[key] = value; }
const result = { options: {} };
const alias = result.options;
const key = "count";
put(alias, key, 2);
console.log("write", result.options[key], alias === result.options);
put(result.options, key, "two");
console.log("replace", alias[key]);
put(alias, "10", true);
put(alias, "2", false);
put(alias, "missing", undefined);
put(alias, "nil", null);
console.log("keys", Object.keys(result.options).join(","));
console.log("presence", Object.hasOwn(alias, "missing"), Object.hasOwn(alias, "absent"));
console.log("absent", alias["absent"] === undefined);
console.log("delete", delete alias[key]);
put(alias, key, 3);
console.log("reinsert", Object.keys(result.options).join(","));

const child = create();
put(child, "value", 4);
put(alias, "child", child);
const childAlias = result.options["child"];
console.log("child", childAlias === child);
put(childAlias, "value", 5);
console.log("mutation", child["value"]);
const independent = create();
console.log("fresh", child !== independent, Object.keys(independent).length);

let order = "";
function receiver() { order += "R"; return alias; }
function computedKey() { order += "K"; return "ordered"; }
function value() { order += "V"; return 9; }
receiver()[computedKey()] = value();
console.log("order", order, alias["ordered"]);
function fail() { order += "F"; throw new Error("value"); }
try { receiver()[computedKey()] = fail(); }
catch (error) { console.log("throw", error instanceof Error, order, alias["ordered"]); }
order = "";
console.log("delete-order", delete receiver()[computedKey()], order, alias["ordered"] === undefined);
console.log("missing-delete", delete alias["absent"]);
delete alias["child"];
console.log("deleted-child", Object.hasOwn(alias, "child"), childAlias === child, child["value"]);
export {};
