// @rust-only
// @no-engine
export {};
const values: string[] = ["z", "\uE000", "𐀀", "a", "a"];
const alias = values;
let calls = 0;
function source(): string[] { calls += 1; return values; }
const result = source().sort();
console.log("identity", result === alias, calls, values.join("|"));
console.log("repeat", result.sort() === values, values.join("|"));
const holes: string[] = ["b", "a"];
holes.length = 6;
holes[3] = "c";
const holesAlias = holes;
console.log("sparse-before", Object.keys(holes).join(","));
console.log("sparse", holes.sort() === holesAlias, holes.length, Object.keys(holes).join(","), holes.join("|"));
const empty: string[] = [];
console.log("empty", empty.sort() === empty, empty.length);
