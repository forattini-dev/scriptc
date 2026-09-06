// @dynamic
// @rust-only
// @island-module: ./io.ts
// Descriptor-level fs inside the island: open/read/write/fstat/
// ftruncate/close over the host's open-file table, in every Node
// spelling (sync, callback, FileHandle).
import { syncRoundTrip, callbackRead, handleRoundTrip, missing } from "./io.ts";

console.log(syncRoundTrip());
console.log(await callbackRead());
console.log(await handleRoundTrip());
console.log(missing());
