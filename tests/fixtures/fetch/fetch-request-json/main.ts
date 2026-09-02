// @dynamic
// Request.json parses its UTF-8 body and disturbs the shared Body state.
const request = new Request("https://example.test/", {
  method: "POST",
  body: '{"answer":42,"label":"ok"}',
});
const value = await request.json() as { answer: number; label: string };
console.log(request.bodyUsed, value.answer, value.label);
