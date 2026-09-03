// A Transform subclass forwarding checked-dynamic options through super keeps
// scalar options and falls back to its prototype _transform/_flush methods.
import { Transform } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

class AgentTransform extends Transform {
  constructor(options: Dynamic) {
    super(options);
  }

  _transform(chunk: Buffer, encoding: string, done: (error?: Error | null, output?: string) => void): void {
    console.log("transform:", chunk.toString(), encoding);
    done(null, chunk.toString().toUpperCase());
  }

  _flush(done: (error?: Error | null, output?: string) => void): void {
    console.log("flush");
    done(null, "!");
  }
}

const transform = new AgentTransform({
  encoding: "utf8",
  readableHighWaterMark: 2,
  writableHighWaterMark: 3,
  allowHalfOpen: false,
});

console.log("hwm:", transform.readableHighWaterMark, transform.writableHighWaterMark);
console.log("half:", transform.allowHalfOpen);
transform.on("data", (chunk: string) => console.log("data:", typeof chunk, chunk));
transform.on("finish", () => console.log("finished"));
transform.on("end", () => console.log("ended"));
transform.end("agent");
