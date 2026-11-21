const resources = new Map();
export function resource(key, create) {
  if (!resources.has(key)) resources.set(key, create());
  return resources.get(key);
}
