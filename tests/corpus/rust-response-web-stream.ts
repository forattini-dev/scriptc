// @rust-only
// @no-engine
const stream = new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(new Uint8Array([239, 187, 191, 240, 159]));
  controller.enqueue(new Uint8Array([152, 128, 255, 65]));
  controller.close();
} });
const first = new Response(stream);
const second = new Response(stream);
console.log("identity", first.body === stream, first.body === second.body, first.bodyUsed, second.bodyUsed);
const text = first.text();
console.log("claimed", first.bodyUsed, second.bodyUsed, stream.locked);
console.log("text", JSON.stringify(await text));
try { await second.text(); } catch (error) { console.log("second", (error as Error).name); }

const locked = new ReadableStream<Uint8Array>();
const lockedReader = locked.getReader();
try { new Response(locked); } catch (error) { console.log("locked", (error as Error).name); }
lockedReader.releaseLock();
const cancelled = new Response(locked);
await cancelled.body!.cancel();
console.log("cancel", cancelled.bodyUsed);
try { await cancelled.text(); } catch (error) { console.log("cancelled read", (error as Error).name); }

const failed = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("source failed")); } });
try { await new Response(failed).text(); } catch (error) { console.log("failed", (error as Error).message); }
const empty = new Response();
console.log("empty", empty.body === null, JSON.stringify(await empty.text()), JSON.stringify(await empty.text()), empty.bodyUsed);
const shared = new Uint8Array([65]);
const mutable = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(shared); controller.close(); } });
shared[0] = 66;
console.log("shared", await new Response(mutable).text());
const invalid = new ReadableStream<string>({ start(controller) { controller.enqueue("wrong chunk"); controller.close(); } });
try { await new Response(invalid as unknown as ReadableStream<Uint8Array>).text(); } catch (error) { console.log("chunk", (error as Error).name); }
export {};
