// @rust-only
// @no-engine
export {};
type View = { nested: { value: string; optional?: number }; callback: (value: string) => string };
function create(): View {
  return { ...{ nested: false, callback: false }, nested: { value: "own" }, callback: value => value + "!" };
}
const view = create();
console.log("context", view.nested.value, view.nested.optional === undefined, Object.hasOwn(view.nested, "optional"), view.callback("x"));
type Item = { value: string; optional?: number };
function array(): { values: Item[] } {
  return { ...{ values: false }, values: [{ value: "array" }] };
}
const values = array().values;
console.log("array context", values[0].value, values[0].optional === undefined, Object.hasOwn(values[0], "optional"));
const owned = { value: "wide", extra: 7 };
const source = { nested: owned };
function narrow(): { nested: { value: string } } { return { ...source }; }
const projected = narrow();
console.log("view", projected.nested === owned, projected.nested.value, Object.keys(projected.nested).join("|"));
