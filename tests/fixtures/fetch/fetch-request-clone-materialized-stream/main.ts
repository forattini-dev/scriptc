// @dynamic
// Internal teeing must not disturb a materialized user-provided stream Body.
async function main(): Promise<void> {
  const source = new Response("streamed").body;
  if (source === null) throw new Error("missing source body");
  const request = new Request("https://example.test/", {
    method: "POST",
    body: source,
    duplex: "half",
  });
  const before = request.body;
  if (before === null) throw new Error("missing request body");
  const clone = request.clone();
  console.log(before.locked, request.body === before,
    clone.body === before, request.body === clone.body,
    request.bodyUsed, clone.bodyUsed as boolean);
  console.log(await request.text() as string, await clone.text() as string,
    request.bodyUsed, clone.bodyUsed as boolean);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
