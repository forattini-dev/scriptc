export function choose(explicit) {
  if (explicit) return explicit;
  return { id: 0, resources: new Map() };
}
export function chooseBlock(explicit) {
  if (explicit) { return explicit; }
  return { id: 0, resources: new Map() };
}
export function select(active, fallback) {
  if (active) return active;
  return fallback;
}
export function unstable(explicit) {
  const clear = () => { explicit = undefined; };
  if (explicit) {
    clear();
    return explicit;
  }
  return undefined;
}
