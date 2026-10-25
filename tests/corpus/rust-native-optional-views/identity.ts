// @rust-only
// @no-engine
export {};
type Base = { width?: number };
type View = { width?: number; height?: number };
function widen(value: Base): View { return value; }
const base: Base = { width: 2 };
const view = widen(base);
console.log("before", base === view, view.height === undefined, Object.hasOwn(view, "height"), Object.keys(view).join("|"));
view.height = 4;
const erased: any = base;
console.log("after", erased.height === 4, Object.hasOwn(base, "height"), Object.keys(base).join("|"));
view.width = 5;
console.log("width", base.width === 5);
view.height = undefined;
console.log("present", Object.hasOwn(base, "height"), erased.height === undefined);
const map = new WeakMap<object, string>();
map.set(base, "same");
console.log("key", map.get(view) === "same");
