export type Key = { id: number };
export const map = new WeakMap<Key, unknown>(); export const key = { id: 1 };
export function put(value: unknown): void { map.set(key, value); }
export function read(): unknown { return map.get(key); }
