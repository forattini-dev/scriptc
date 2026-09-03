// PassThrough constructed through dynamically-forwarded options keeps its
// transform identity while applying the shared stream scalar options.
import { PassThrough } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

function passthroughFrom(options: Dynamic): PassThrough {
  return new PassThrough(options);
}

const passthrough = passthroughFrom({
  encoding: "utf8",
  highWaterMark: 2,
});

console.log("hwm:", passthrough.readableHighWaterMark, passthrough.writableHighWaterMark);
passthrough.on("data", (chunk: string) => console.log("data:", typeof chunk, chunk));
passthrough.on("end", () => console.log("end"));
passthrough.end("agent");
