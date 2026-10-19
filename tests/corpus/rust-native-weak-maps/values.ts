// @rust-only
// @no-engine
type Key = { id: number }; const key = { id: 2 }; const other = { id: 3 }; const map = new WeakMap<Key, unknown>();
const callback = () => key.id; map.set(key, callback);
console.log("function", map.get(key) === callback, (map.get(key) as () => number)());
const array = [1, 2]; map.set(key, array); console.log("array", map.get(key) === array);
const promise = Promise.resolve(7); map.set(key, promise); console.log("promise", map.get(key) === promise);
const value = { key }; map.set(key, value); console.log("back reference", (map.get(key) as { key: Key }).key === key);
map.set(other, null); console.log("null", map.has(other), map.get(other) === null);
function cycle(): boolean { const owner = new WeakMap<Key, () => number>(); const object = { id: 9 }; const read = () => owner.has(object) ? object.id : 0; owner.set(object, read); console.log("owner cycle", owner.get(object) === read, read()); return true; }
cycle();
