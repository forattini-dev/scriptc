// @dynamic
// Request.clone rejects after its Body has been consumed.
async function main(): Promise<void> {
  const request = new Request("https://example.test/", {
    method: "POST",
    body: "used",
  });
  await request.text();
  try {
    request.clone();
    console.log("cloned");
  } catch (error) {
    const reason = error as Error;
    console.log(reason.name, reason.message, request.bodyUsed);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
