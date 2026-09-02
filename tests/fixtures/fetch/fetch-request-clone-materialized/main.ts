// @dynamic
// Cloning tees a materialized Body and replaces both Request stream handles.
async function main(): Promise<void> {
  const request = new Request("https://example.test/", {
    method: "POST",
    body: "hello",
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
