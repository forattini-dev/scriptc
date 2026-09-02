// @dynamic
// A typed ArrayBuffer returned by Request survives a top-level slot.
const request = new Request("https://example.test/", {
  method: "POST",
  body: "hé",
});
const buffer = await request.arrayBuffer();

console.log(request.bodyUsed, buffer.byteLength);
