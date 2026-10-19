// @rust-only
// @no-engine
import { map, key, put, read, type Key } from "./store.ts";
const aliases: WeakMap<Key, unknown>[] = [map, map]; const value = { id: 7 };
console.log("module", aliases[0] === aliases[1], read() === undefined);
put(value); console.log("module value", aliases[1].get(key) === value, read() === value);
