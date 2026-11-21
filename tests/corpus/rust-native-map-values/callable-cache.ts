type Plugin = (name: string) => string;

const cache = new Map<string, Plugin>();
const plugin: Plugin = (name) => `plugin:${name}`;
cache.set("main", plugin);

const saved = cache.get("main");
if (saved === undefined) {
  throw new Error("missing plugin");
}

console.log(saved === plugin, saved("job"), cache.size);
