const store = {};
export const fixed = {value: 1};
export function update(value) { store.value = value; fixed.value = value; }
export function snapshot() { return store; }
