// @rust-only
// @no-engine
type Key = { id: number }; const map = new WeakMap<Key, unknown>(); const key = { id: 1 };
function receiver(): WeakMap<Key, unknown> { console.log("receiver"); return map; }
function getKey(): Key { console.log("key", map.has(key)); return key; }
function value(): { key: Key } { console.log("value", map.has(key)); return { key }; }
receiver().set(getKey(), value()); console.log("after", map.has(key));
try { receiver().set(1 as any, value()); } catch (error) { if (error instanceof Error) console.log("invalid", error.name, error.message); }
console.log("primitive reads", map.get(1 as any) === undefined, map.has(null as any), map.delete("no" as any));
function fail(): Key { console.log("throw key"); throw new Error("key failed"); }
try { receiver().set(fail(), value()); } catch (error) { if (error instanceof Error) console.log("caught", error.message); }
