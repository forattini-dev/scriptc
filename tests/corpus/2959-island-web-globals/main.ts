// @dynamic
// @rust-only
// @island-module: ./web.ts
// Web-platform globals inside the island: events, message channels,
// structuredClone, Blob/File, FormData, performance and navigator behave
// as Node's.
import { run } from "./web.ts";

for (const line of await run()) console.log(line);
