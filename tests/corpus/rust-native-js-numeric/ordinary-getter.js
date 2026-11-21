"use strict";
let calls = 0;
const object = {};
const alias = object;
const returned = Object.defineProperty(object, "value", {
  get() { calls++; return this === alias ? 7 : 0; },
  enumerable: true,
  configurable: true,
});
console.log("identity", returned === alias);
console.log("reads", object.value, alias.value, calls);
console.log("keys", Object.keys(object).join(","));
console.log("json", String(JSON.stringify(object)));
console.log("delete", delete object.value, Object.keys(object).length);
Object.defineProperty(object, "locked", { get() { return 9; } });
console.log("hidden", object.locked, Object.keys(object).length);
try { delete object.locked; } catch (error) { console.log("locked", error instanceof TypeError); }
try { Object.defineProperty(object, "locked", { value: 3, writable: true, enumerable: true, configurable: true }); }
catch (error) { console.log("redefine locked", error instanceof TypeError); }
Object.defineProperty(object, "replace", { get() { return 1; }, configurable: true });
Object.defineProperty(object, "replace", { value: 11, writable: true, enumerable: true, configurable: true });
console.log("replaced", object.replace, Object.keys(object).join(","));
console.log("json hidden", String(JSON.stringify(object)));
function fn(text) { return text; }
Object.defineProperty(fn, "isSelf", { get() { return this === fn; } });
console.log("function", String(fn.isSelf), Object.keys(fn).length);
function cycle() {
  const owner = {};
  Object.defineProperty(owner, "self", { get() { return this === owner; } });
  return owner.self;
}
console.log("cycle", String(cycle()));
const mutable = {};
Object.defineProperty(mutable, "once", {
  get() { delete mutable.once; return 5; },
  configurable: true,
});
console.log("reentrant", String(mutable.once), "once" in mutable);
