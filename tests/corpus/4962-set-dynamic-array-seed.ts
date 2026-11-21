// @rust-only
// @no-engine
const values: any = ["a", "b", "a"];
const selected = new Set<string>(values);
console.log(selected.size, selected.has("a"));
