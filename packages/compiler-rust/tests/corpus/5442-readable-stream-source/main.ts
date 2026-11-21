async function main() {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([65])); },
    pull(controller) { controller.close(); },
    cancel() { cancelled = true; }
  });
  const reader = stream.getReader();
  const first = await reader.read();
  const second = await reader.read();
  console.log(first.value?.[0], first.done, second.done, cancelled);
}
void main();
