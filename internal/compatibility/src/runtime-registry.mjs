import { readFileSync } from "node:fs";

const packageRoot = new URL("../", import.meta.url);

/** Runtime linkage is broader than the independently test-backed API inventory. */
export function runtimeRegistry(manifest) {
  const config = manifest.runtimeRegistry;
  const partsUrl = new URL(config.parts, packageRoot);
  const parts = JSON.parse(readFileSync(partsUrl, "utf8"));
  const exports = JSON.parse(readFileSync(new URL(config.exports, packageRoot), "utf8"));
  const registered = new Set();
  for (const file of parts[config.backend]) {
    const source = readFileSync(new URL(file, partsUrl), "utf8");
    for (const match of source.matchAll(/^\s+builtins(?:\.([\w]+)|\['([^']+)'\])\s*=\s*memo\(/gm)) {
      registered.add(`node:${match[1] ?? match[2]}`);
    }
  }
  const registry = {};
  for (const module of registered) {
    const names = config.overrides?.[module] ?? exports[module];
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name))) {
      throw new Error(`Missing or invalid runtime exports for '${module}'`);
    }
    registry[module] = names;
  }
  for (const module of Object.keys(config.overrides ?? {})) {
    if (!registered.has(module)) throw new Error(`Runtime export override for unregistered '${module}'`);
  }
  for (const [module, entry] of Object.entries(manifest.modules)) {
    const names = registry[`node:${module}`];
    for (const name of entry.exports) {
      if (!names?.includes(name)) {
        throw new Error(`Compatibility export '${module}.${name}' has no runtime binding`);
      }
    }
  }
  return registry;
}
