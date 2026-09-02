// @dynamic
// Request.clone tees a user-provided ReadableStream Body.
async function main(): Promise<void> {
  const body = new Response("streamed").body;
  if (body === null) throw new Error("missing stream body");
  const request = new Request("https://example.test/", {
    method: "POST",
    body,
    duplex: "half",
  });
  const clone = request.clone();
  console.log(await request.text() as string, await clone.text() as string,
    request.bodyUsed, clone.bodyUsed as boolean);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
