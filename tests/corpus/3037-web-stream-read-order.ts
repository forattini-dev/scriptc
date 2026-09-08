// Resolving a native read must not insert an extra promise reaction turn.
async function main(): Promise<void> {
  const stream = new ReadableStream<number>({
    start(controller) { controller.enqueue(7); controller.close(); },
  });
  const reader = stream.getReader();
  const first = reader.read().then((value) => { console.log("read", value.value); });
  queueMicrotask(() => console.log("microtask"));
  console.log("sync");
  await first;
  const end = reader.read().then((value) => { console.log("end", value.done); });
  queueMicrotask(() => console.log("after-end"));
  await end;
  reader.releaseLock();
}
void main();
