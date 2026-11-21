export function inspect(key, create) {
  const registry = create();
  return registry.states.has(key);
}
