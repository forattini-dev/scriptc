// A Transform callback nested in dynamically-forwarded options must keep its
// typed chunk/encoding/completion boundary and emit the callback's output.
import { Transform } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;
type TransformDone = (error?: Error | null, data?: Buffer | string) => void;

function transformFrom(options: Dynamic): Transform {
  return new Transform(options);
}

const transform = transformFrom({
  readableHighWaterMark: 2,
  writableHighWaterMark: 3,
  transform(chunk: Buffer, encoding: string, done: TransformDone) {
    console.log("transform:", chunk.toString(), encoding);
    done(null, chunk.toString().toUpperCase());
  },
});

console.log("hwm:", transform.readableHighWaterMark, transform.writableHighWaterMark);
transform.setEncoding("utf8");
transform.on("data", (chunk: string) => console.log("data:", chunk));
transform.on("end", () => console.log("end"));
transform.end("agent");
