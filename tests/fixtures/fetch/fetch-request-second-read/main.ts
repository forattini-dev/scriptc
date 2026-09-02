// @dynamic
// A Body is disturbed by its first read and rejects every later read.
const request = new Request("https://example.test/", {
  method: "POST",
  body: "once",
});
await request.text();
try {
  await request.text();
  console.log("resolved");
} catch (error) {
  const reason = error as Error;
  console.log(reason.name, reason.message, request.bodyUsed);
}
