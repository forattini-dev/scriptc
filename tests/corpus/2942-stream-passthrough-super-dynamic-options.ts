// A PassThrough subclass forwarding checked-dynamic options through super
// keeps its Transform identity and scalar options while forwarding bytes.
import { PassThrough } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

class AgentPassThrough extends PassThrough {
  constructor(options: Dynamic) {
    super(options);
  }
}

const stream = new AgentPassThrough({
  encoding: "utf8",
  readableHighWaterMark: 2,
  writableHighWaterMark: 3,
  allowHalfOpen: false,
});

console.log("hwm:", stream.readableHighWaterMark, stream.writableHighWaterMark);
console.log("half:", stream.allowHalfOpen);
stream.on("data", (chunk: string) => console.log("data:", typeof chunk, chunk));
stream.on("finish", () => console.log("finished"));
stream.on("end", () => console.log("ended"));
stream.end("agent");
