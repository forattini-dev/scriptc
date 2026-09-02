// @dynamic
// Reading Request.body directly disturbs the shared Body state.
async function main(): Promise<void> {
  const request = new Request("https://example.test/", {
    method: "POST",
    body: "hé",
  });
  const body = request.body;
  if (body === null) throw new Error("missing request body");
  const reader = body.getReader();
  console.log(request.bodyUsed);
  await reader.read();
  console.log(request.bodyUsed);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
