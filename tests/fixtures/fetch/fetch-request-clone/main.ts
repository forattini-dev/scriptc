// @dynamic
// Request.clone creates a distinct Body that can be consumed independently.
async function main(): Promise<void> {
  const request = new Request("https://example.test/path", {
    method: "POST",
    body: "hello",
  });
  const clone = request.clone();
  console.log(clone === request, clone instanceof Request,
    clone.method as string, clone.url === request.url,
    request.bodyUsed, clone.bodyUsed as boolean);
  console.log(await request.text() as string, await clone.text() as string,
    request.bodyUsed, clone.bodyUsed as boolean);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
