// @rust-only
// @no-engine
export {};
type Base = { width: number };
type View = { width: number; height?: number };
function widen(value: Base | undefined): View | undefined { return value; }
const base: Base = { width: 4 };
const view = widen(base);
const missing = widen(undefined);
console.log("nullable", missing === undefined, view === base);
function observe(value: View): void { console.log("read", value.width, value.height === undefined, Object.hasOwn(value, "height")); }
if (view !== undefined) observe(view);
