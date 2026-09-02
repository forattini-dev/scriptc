// @dynamic
// Request.text consumes its body once and flips the public bodyUsed state.
const request = new Request("https://example.test/", {
  method: "POST",
  body: "hello 🌍",
});
console.log(request.bodyUsed);
console.log(await request.text() as string);
console.log(request.bodyUsed);
