import { connect } from "./kv.js";
const kv = connect();
async function sweep(referenced: Set<string>): Promise<void> {
  const listed = await kv.list({ limit: 10_000 }).catch(() => ({ items: [] as Array<{ key: string }> }));
  for (const entry of listed.items) {
    if (entry.key.startsWith("blob:") && !referenced.has(entry.key)) {
      await kv.delete(entry.key);
    }
  }
  console.log("swept", listed.items.length);
}
function* keys(): Generator<{ key: string }> { yield { key: "blob:g1" }; yield { key: "meta:g2" }; }
async function sweepGenerator(source: Iterable<{ key: string }>): Promise<number> {
  let deleted = 0;
  for (const entry of source) {
    if (entry.key.startsWith("blob:")) {
      await kv.delete(entry.key);
      deleted += 1;
    }
  }
  return deleted;
}
sweep(new Set(["blob:c"]))
  .then(() => sweepGenerator(keys()))
  .then((count) => console.log("generator deleted", count))
  .then(() => sweepGenerator([{ key: "blob:x" }]))
  .then((count) => console.log("array deleted", count));
