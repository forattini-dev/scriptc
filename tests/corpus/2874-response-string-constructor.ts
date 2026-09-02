// A static Response constructed from text owns the UTF-8 bytes that its
// asynchronous body reader exposes, without requiring an HTTP exchange.
async function main(): Promise<void> {
  const response = new Response("local hé ✓");
  console.log(await response.text());
}

void main();
