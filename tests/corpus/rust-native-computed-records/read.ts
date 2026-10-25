// @rust-only
// @no-engine
// @ts-nocheck
export {};
const child = {value: 1};
const data = {"": child, text: "hello", count: 7, missing: undefined, nil: null, "0": "zero", "true": "yes"};
function read(key: string) { return data[key]; }
console.log("fields", read("text") === "hello", read("count") === 7, read("missing") === undefined, read("nil") === null, read("absent") === undefined);
console.log("identity", read("") === child);
child.value = 9;
console.log("mutation", read("").value === 9);
let index = -0;
let flag = true;
console.log("keys", data[index] === "zero", data[flag] === "yes");
console.log("assertions", data[index as unknown as string] === "zero", data[flag as any] === "yes");
const rootHolder = {"": JSON.parse('{"ok":true}')};
const stack = [{parent: rootHolder, key: "", visited: false}];
const node = stack[stack.length - 1];
const value = node.parent[node.key];
console.log("holder", value.ok === true, Object.keys(value).join(",") === "ok");
function typed(key: "left" | "right"): number { const values = {left: 3, right: 8}; return values[key]; }
console.log("typed", typed("left"), typed("right"));
