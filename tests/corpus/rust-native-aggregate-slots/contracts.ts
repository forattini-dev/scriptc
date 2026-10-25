// @rust-only
// @no-engine
const factory = () => ({ type: "box", props: {}, children: [], key: undefined });
const node = factory();
console.log("factory", node.type, node.children.length, node.key === undefined);
const keys = Object.keys(node);
console.log("presence", keys.length, keys.join(",").includes("key"), keys.join(",").includes("children"));
const units = { missing: undefined, empty: null };
console.log("units", units.missing === undefined, units.empty === null, units.missing !== units.empty);
const nulls: null[] = [null, null];
const undefineds: undefined[] = [undefined, undefined];
const empty: never[] = [];
console.log("arrays", nulls.length, nulls[0] === null, undefineds.length, undefineds[1] === undefined, empty.length);
console.log("absent", empty[0] === undefined, nulls[3] === undefined, undefineds[3] === undefined);
const nested = { values: [{ child: null, children: [], key: undefined }] };
console.log("nested", nested.values[0].child === null, nested.values[0].children.length, nested.values[0].key === undefined);
