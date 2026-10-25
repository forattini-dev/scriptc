// @rust-only
// @no-engine
export {};
const defaults = { enabled: false, count: 1 };
const alias = defaults;
const clone = { ...alias, enabled: "on" };
alias.count = 9;
console.log("alias", clone.enabled, clone.count, defaults.count);
const middle = { value: "middle" };
const final = { ...{ value: false }, ...middle, value: 23 };
console.log("chain", final.value, middle.value);
// @ts-expect-error JavaScript permits duplicate properties; the last write wins.
const direct = { value: false, ...{ value: "middle" }, value: 5 };
console.log("direct", direct.value);
function capture() {
  const base = { value: false };
  const result = { ...base, value: ["kept"] };
  return () => result;
}
const get = capture();
get().value.push("live");
console.log("capture", get() === get(), get().value.join("|"));
