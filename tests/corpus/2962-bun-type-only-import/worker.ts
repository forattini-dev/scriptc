// A worker script: its top level registers a message handler on the
// worker's global — evaluating it in the main realm is an error.
export type rpc = { ping(): string };
(globalThis as { onmessage?: unknown }).onmessage = () => {};
console.log("worker evaluated");
