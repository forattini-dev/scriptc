// @dynamic
// Aborting fetch closes the native transport rather than only rejecting its
// public promise while the socket remains alive in the event loop.
const key = String(process.pid);
try {
  await fetch(`${process.argv[2]}/slow?key=${key}`, {
    signal: AbortSignal.timeout(500),
  });
} catch {}
await new Promise<void>((resolve) => setTimeout(resolve, 100));
const response = await fetch(`${process.argv[2]}/slow-state?key=${key}`);
const state: string = await response.text();
console.log(state);
