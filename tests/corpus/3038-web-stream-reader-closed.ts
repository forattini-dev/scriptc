// The admitted closed property is awaitable and reflects release and failure.
async function main(): Promise<void> {
  const stream = new ReadableStream<number>({ start(controller) { controller.enqueue(1); controller.close(); } });
  const reader = stream.getReader();
  console.log(reader.closed === reader.closed);
  console.log("read", (await reader.read()).value);
  await reader.closed;
  console.log("closed");
  reader.releaseLock();
  try { await reader.closed; } catch (error) { console.log("released", error instanceof TypeError); }
  const failed = new ReadableStream<number>({ start(controller) { controller.error(new Error("closed failed")); } });
  const failedReader = failed.getReader();
  try { await failedReader.closed; } catch (error) { console.log((error as Error).message); }
  failedReader.releaseLock();
}
void main();
