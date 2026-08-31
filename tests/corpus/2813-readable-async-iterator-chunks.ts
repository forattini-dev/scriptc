import { Readable } from "node:stream";

const readable = new Readable({ read() {} });
readable.push("one ");
readable.push("two");
readable.push(null);

for await (const chunk of readable) {
  console.log(chunk.toString(), chunk.length);
}
