// @dynamic
// Request.arrayBuffer consumes its body and exposes the complete byte length.
async function main(): Promise<void> {
  const request = new Request("https://example.test/", {
    method: "POST",
    body: "hé",
  });
  const buffer = await (request as any).arrayBuffer();
  console.log(request.bodyUsed, buffer.byteLength as number);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
