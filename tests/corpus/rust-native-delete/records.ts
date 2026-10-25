// @rust-only
// @no-engine
// @ts-nocheck
export {};
const object = {left: 1, remove: undefined, right: 3};
const alias = object;
console.log("before", Object.keys(object).join(","), Object.hasOwn(object, "remove"));
console.log("delete", delete object.remove, Object.hasOwn(alias, "remove"));
console.log("missing", delete object.remove, delete object.absent);
console.log("after", Object.keys(alias).join(","), object.remove === undefined);
const parsed = JSON.parse('{"a":1,"b":2}');
const parsedAlias = parsed;
console.log("parsed", delete parsed.a, Object.keys(parsedAlias).join(","), parsedAlias.a === undefined);
const rootHolder = {"": parsed};
const node = {parent: rootHolder, key: ""};
const {parent, key} = node;
console.log("holder", delete parent[key], Object.keys(rootHolder).length, Object.hasOwn(rootHolder, ""));
