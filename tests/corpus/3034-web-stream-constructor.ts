// Native streams preserve queued values, locks and synchronous start ordering.
async function main(): Promise<void> {
  const chunk = new Uint8Array([0, 255, 128, 65]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      console.log("start", controller.desiredSize);
      controller.enqueue(chunk);
      console.log("queued", controller.desiredSize);
      controller.close();
    },
  });
  console.log("constructed", stream.locked);
  chunk[0] = 7;
  const reader = stream.getReader();
  console.log("locked", stream.locked);
  const first = await reader.read();
  console.log(first.done, first.value === chunk, first.value!.join(","));
  console.log((await reader.read()).done, (await reader.read()).done);
  reader.releaseLock();
  console.log("released", stream.locked);
  const again = stream.getReader();
  console.log((await again.read()).done);
  again.releaseLock();
}
void main();
