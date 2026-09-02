// @dynamic
// A materialized Response clone owns an independent body and Headers snapshot.
async function main(): Promise<void> {
  const original = new Response("hé", {
    status: 201,
    statusText: "Created",
    headers: { "x-copy": "original" },
  });
  const clone = original.clone();
  clone.headers.set("x-copy", "clone");

  console.log(original.status, clone.status, original.statusText, clone.statusText);
  console.log(original.headers.get("x-copy") as string | null,
    clone.headers.get("x-copy") as string | null);
  console.log(original.bodyUsed, clone.bodyUsed);
  console.log(await original.text() as string, original.bodyUsed, clone.bodyUsed);
  console.log(await clone.text() as string, original.bodyUsed, clone.bodyUsed);

  const empty = new Response(null);
  const emptyClone = empty.clone();
  console.log(empty.body === null, emptyClone.body === null);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
