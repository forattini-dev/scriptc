// @rust-only
// @no-engine
export {};
class WeakMap { get(key: { id: number }): number { return key.id + 3; } }
const map = new WeakMap(); console.log("shadow", map.get({ id: 4 }));
