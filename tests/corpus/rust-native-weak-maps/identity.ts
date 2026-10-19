// @rust-only
// @no-engine
type Key = { id: number }; type Payload = { name: string };
const map = new WeakMap<Key, Payload>(); const other = new WeakMap<Key, Payload>(); const first = { id: 1 }; const second = { id: 1 }; const value = { name: "first" };
console.log("empty", typeof map, map !== other, map.get(first) === undefined, map.has(first));
console.log("chaining", map.set(first, value) === map, map.has(first), map.has(second), other.has(first));
console.log("value identity", map.get(first) === value); first.id = 7; value.name = "updated";
const found = map.get(first); if (found !== undefined) console.log("mutation", found.name, map.has(first));
map.set(first, { name: "replacement" }); const replacement = map.get(first); if (replacement !== undefined) console.log("overwrite", replacement.name);
console.log("delete", map.delete(second), map.delete(first), map.delete(first), map.has(first));
const erased = new WeakMap<Key, unknown>(); erased.set(first, undefined);
console.log("stored undefined", erased.has(first), erased.get(first) === undefined, erased.get(second) === undefined, erased.has(second));
const wide = { id: 12, extra: "kept" }; const narrow: Key = wide; map.set(wide, value); console.log("structural key", map.has(narrow), map.get(narrow) === value);
