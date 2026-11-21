// A dynamic client (`any`) listing keys; the checker still types the
// `.catch` fallback as an Array, so the loop is an Array iteration.
interface Item {
  readonly key: string;
}

const client: any = {
  async list(options: { limit: number }) {
    console.log("list", options.limit);
    return { items: [{ key: "blob:a" }, { key: "blob:b" }, { key: "meta:c" }, { key: "blob:c" }] };
  },
  async delete(key: string) {
    await Promise.resolve();
    console.log("delete", key);
  },
};

async function deleteUnreferenced(live: readonly { blob_key?: string }[]): Promise<void> {
  const referenced = new Set(live.map((entry) => entry.blob_key).filter((key): key is string => typeof key === "string"));
  const listed: { items: Item[] } = await client.list({ limit: 10_000 }).catch(() => ({ items: [] as Item[] }));
  for (const entry of listed.items) {
    if (entry.key.startsWith("blob:") && !referenced.has(entry.key)) {
      await client.delete(entry.key);
    }
  }
  console.log("swept", listed.items.length);
}

const failing: any = {
  async list() {
    throw new Error("offline");
  },
};

async function listOrEmpty(): Promise<number> {
  const listed: { items: Item[] } = await failing.list().catch((error: Error) => {
    console.log("fallback", error.message);
    return { items: [] as Item[] };
  });
  return listed.items.length;
}

deleteUnreferenced([{ blob_key: "blob:b" }, {}])
  .then(() => listOrEmpty())
  .then((count) => console.log("done", count));
console.log("scheduled");
