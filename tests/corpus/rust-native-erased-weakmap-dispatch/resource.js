export function inspect(key, create) {
  const registry = create();
  registry.states.set(registry, 7);
  const before = registry.states.has(key);
  registry.states.delete(key);
  return [before, registry.states.has(key), registry.states.get(registry), registry.states.get({})];
}
