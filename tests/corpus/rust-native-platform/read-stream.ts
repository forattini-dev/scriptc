// @rust-only
// @no-engine
import { createReadStream, rmSync, writeFileSync } from "node:fs";

const path = `${import.meta.filename}.stream-data`;
writeFileSync(path, "x".repeat(70_000));
let chunks = 0;
let bytes = 0;
for await (const chunk of createReadStream(path)) {
  chunks++;
  bytes += chunk.length;
}
rmSync(path);
console.log("stream", chunks, bytes);
