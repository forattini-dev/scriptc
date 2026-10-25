// @rust-only
// @no-engine
export {};
type Base = { label: string };
type View = { label: string; items?: string[]; callback?: (value: string) => string };
function widen(value: Base): View { return value; }
function capture(value: Base): () => View { const view = widen(value); return () => view; }
const base: Base = { label: "base" };
const get = capture(base);
const view = get();
console.log("absent", view === base, get() === view, view.items === undefined, view.callback === undefined, Object.keys(base).join("|"));
const items = ["a"];
const callback = (value: string) => value + "!";
view.items = items;
view.callback = callback;
console.log("stored", get().items === items, get().callback === callback, Object.keys(base).join("|"));
const call = get().callback;
if (call) console.log("call", call("x"));
items.push("b");
console.log("array", get().items === items, items.join("|"));
