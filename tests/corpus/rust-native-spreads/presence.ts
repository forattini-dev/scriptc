type Item = { tag: string; value?: string; callback?: (text: string) => string };
function item(present: boolean): Item {
  return { tag: "item", ...(present ? { value: undefined } : {}) };
}
const missing = item(false);
const present = item(true);
const alias = missing;
console.log(missing.value === undefined, present.value === undefined);
console.log(Object.hasOwn(missing, "value"), Object.hasOwn(present, "value"));
const snapshot = Object.keys(missing);
alias.value = undefined;
console.log(Object.hasOwn(missing, "value"), snapshot.length, Object.keys(missing).length);
const fn = (text: string) => text + "!";
const callable: Item = { tag: "callback", ...(true ? { callback: fn } : {}) };
console.log(callable.callback === fn, Object.hasOwn(callable, "callback"));
const empty: {} = { ...{} };
console.log(Object.keys(empty).length, Object.hasOwn(empty, "toString"));
function overwrite(yes: boolean): { a: string; b?: string } {
  return { a: "original", ...(yes ? { a: "replacement" } : {}), ...(yes ? { b: "b" } : {}) };
}
const overwritten = overwrite(true);
const overwrittenKeys = Object.keys(overwritten);
console.log("override", overwritten.a, overwrittenKeys[0], overwrittenKeys[1]);
function variable(input?: string): { a: string; b?: string } {
  var text = input;
  return { a: "a", ...(text !== undefined ? { b: text + "!" } : {}) };
}
console.log(Object.hasOwn(variable(), "b"), variable("b").b === "b!");
const __proto__ = "own data";
const own: { tag: string; __proto__?: string } = { tag: "own", ...{ __proto__ } };
console.log(Object.hasOwn(own, "__proto__"), own.__proto__ === "own data", Object.keys(own)[1]);
