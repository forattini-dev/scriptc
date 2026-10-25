// @rust-only
// @no-engine
export {};
const defaults = { notifications: false, mouse: false };
const profile = { ...defaults, notifications: "osc99" };
console.log("profile", profile.notifications, profile.mouse, defaults.notifications);
const named = { value: "initial", keep: 3 };
const number = { ...named, value: 42 };
console.log("number", number.value, number.keep, named.value);
const inline = { ...{ value: false }, ...{ value: "middle" }, ...{ value: 7 } };
console.log("inline", inline.value, Object.keys(inline).join("|"));
const nil = { ...{ value: 1 }, value: null };
const absent = { ...{ value: "old" }, value: undefined };
console.log("units", nil.value === null, absent.value === undefined, Object.hasOwn(absent, "value"));
function conditional(yes: boolean) {
  return { ...{ value: false }, ...(yes ? { value: 12 } : { value: "no" }), value: "final" };
}
console.log("conditional", conditional(true).value, conditional(false).value);
console.log("array keys", Object.keys(["a"]).length);
