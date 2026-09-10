// @rust-only
// @no-engine
interface Wide { count: number; label: string; optional?: string }
interface Narrow { count: number }
const source: Wide = { count: 1, label: "extra" };
let calls = 0;
function factory(): Wide { calls++; return source; }
function project(value: Narrow): Narrow { return value; }
const narrow = project(factory());
narrow.count = 4;
console.log("count", source.count, calls);
console.log("keys", Object.keys(narrow).join(","));
console.log("values", Object.values(source).join(","));
for (const [key, value] of Object.entries(source)) console.log("entry", key, value);
source.optional = undefined;
console.log("explicit undefined", Object.keys(narrow).join(","));
for (const [key, value] of Object.entries(source)) console.log("entry undefined", key, value);
const opaque: unknown = source;
console.log("identity", narrow === (opaque as Narrow));
source.label = "updated";
console.log("json", JSON.stringify(narrow));
const named = { "10": 10, "2": 2, value: 3 };
function numeric(value: { value: number }): void { console.log("ordered", Object.keys(value).join(",")); }
numeric(named);
export {};
