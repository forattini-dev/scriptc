// @rust-only
// @no-engine
const scopes = new Set();
const scope = { id: 1 }; const other = { id: 1 };
scopes.add(scope); scopes.add(scope); scopes.add(other);
console.log("JS scopes", scopes.size, scopes.has(scope), scopes.has({ id: 1 }));
const mixed = new Set([scope, scope, true, 0 / 0, 0 / 0, undefined]);
console.log("JS seed", mixed.size, mixed.has(0 / 0), mixed.has(scope), mixed.has(undefined));
function scheduleCycle() {
  const set = new Set(); const read = () => set.size; const record = { read };
  set.add(record); Promise.resolve(1).then(() => console.log("record cycle", set.has(record), read()));
  return true;
}
scheduleCycle();
