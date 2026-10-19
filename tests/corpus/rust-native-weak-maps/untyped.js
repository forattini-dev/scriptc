// @rust-only
// @no-engine
const maps = new WeakMap(); const key = { id: 1 }; const value = { key }; maps.set(key, value);
console.log("JS", maps.get(key) === value, maps.has({ id: 1 }), maps.set(key, value) === maps);
function cycle() { const key = { id: 8 }; const value = { key }; maps.set(key, value); return true; }
cycle();
function ownerCycle() { const map = new WeakMap(); const key = { id: 3 }; const read = () => map.has(key); map.set(key, { read, key }); return true; }
ownerCycle();
function delayed() { const map = new WeakMap(); const key = { id: 4 }; const value = { key }; map.set(key, value); Promise.resolve(1).then(() => console.log("queued", map.get(key) === value)); return true; }
delayed();
