// @dynamic
// Request.body is null without a payload and a lazy readable stream otherwise.
const empty = new Request("https://example.test/");
const request = new Request("https://example.test/", {
  method: "POST",
  body: "hé",
});
const body = request.body;
console.log(empty.body === null);
if (body === null) {
  console.log("null");
} else {
  console.log(body.locked, request.bodyUsed);
  const reader = body.getReader();
  console.log(body.locked, request.bodyUsed);
  reader.releaseLock();
  console.log(body.locked);
}
