// @dynamic
// Request.bytes consumes its body and returns the exact UTF-8 payload.
const request = new Request("https://example.test/", {
  method: "POST",
  body: "hé",
});
const bytes = await request.bytes();
console.log(request.bodyUsed, bytes.length, bytes[0], bytes[1], bytes[2]);
