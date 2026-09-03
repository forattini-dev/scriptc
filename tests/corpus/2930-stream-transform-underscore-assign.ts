// Transform underscore methods assigned after construction replace the empty
// prototype hooks. Both callbacks keep the stream as `this`; _flush appends its
// final output before end, matching Node's callback ordering.
import { Transform } from "node:stream";

const transform = new Transform();
transform._transform = function (
  chunk: Buffer,
  encoding: string,
  callback: (error?: Error | null, data?: Buffer | string) => void,
): void {
  console.log("transform", this === transform, encoding);
  callback(null, chunk.toString().toUpperCase());
};
transform._flush = function (
  callback: (error?: Error | null, data?: Buffer | string) => void,
): void {
  console.log("flush", this === transform);
  callback(null, "!");
};

const chunks: string[] = [];
transform.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
transform.on("end", () => console.log("result", chunks.join("")));
transform.end("agent");
