// @dynamic
// Request.clone rejects a locked Body even before the reader consumes it.
const request = new Request("https://example.test/", {
  method: "POST",
  body: "locked",
});
const body = request.body;
if (body === null) throw new Error("missing request body");
const reader = body.getReader();
try {
  request.clone();
  console.log("cloned");
} catch (error) {
  const reason = error as Error;
  console.log(reason.name, reason.message, request.bodyUsed);
}
reader.releaseLock();
