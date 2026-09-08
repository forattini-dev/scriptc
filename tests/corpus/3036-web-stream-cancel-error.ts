// Cancel settles pending reads and preserves callback rejection/error reasons.
async function main(): Promise<void> {
  const empty = new ReadableStream<number>();
  const releasedReader = empty.getReader();
  const interrupted = releasedReader.read();
  releasedReader.releaseLock();
  try { await interrupted; } catch (error) { console.log("pending release", error instanceof TypeError); }
  const replacement = empty.getReader();
  try { await empty.cancel(); } catch (error) { console.log("locked cancel", error instanceof TypeError); }
  await replacement.cancel();
  console.log("empty", (await replacement.read()).done);
  replacement.releaseLock();
  let cancels = 0;
  const stream = new ReadableStream<number>({
    async cancel(reason) {
      cancels++;
      console.log("cancel", reason);
      await Promise.resolve();
      console.log("cancelled");
    },
  });
  const reader = stream.getReader();
  const pending = reader.read();
  await reader.cancel("stop");
  console.log((await pending).done, (await reader.read()).done, cancels);
  await reader.cancel("again");
  console.log(cancels);
  reader.releaseLock();
  try { await reader.read(); } catch (error) { console.log("released", error instanceof TypeError); }
  const bad = new ReadableStream<number>({
    start(controller) { controller.enqueue(1); controller.error(new Error("broken")); },
  });
  const badReader = bad.getReader();
  try { await badReader.read(); } catch (error) { console.log("read", (error as Error).message); }
  try { await badReader.cancel(); } catch (error) { console.log("cancel", (error as Error).message); }
  badReader.releaseLock();
  try { new ReadableStream({ start() { throw new Error("start failed"); } }); }
  catch (error) { console.log((error as Error).message); }
}
void main();
