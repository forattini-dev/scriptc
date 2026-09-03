// User-authored emit("data", chunk) uses the stream data ABI for both
// string and Buffer payloads and returns whether a listener observed it.
import { Readable } from "node:stream";

const strings = new Readable({ read() {} });
strings.on("data", (chunk: string) => console.log("string", chunk));
console.log("heard string", strings.emit("data", "manual"));
strings.destroy();

const buffers = new Readable({ read() {} });
buffers.on("data", (chunk: Buffer) => console.log("buffer", chunk.toString()));
console.log("heard buffer", buffers.emit("data", Buffer.from("bytes")));
buffers.destroy();
