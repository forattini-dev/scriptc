// Dynamic Transform options preserve the flush callback and its final output
// before the readable side reaches end.
import { Transform } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;
type TransformDone = (error?: Error | null, data?: Buffer | string) => void;

function transformFrom(options: Dynamic): Transform {
  return new Transform(options);
}

const transform = transformFrom({
  transform(chunk: Buffer, _encoding: string, done: TransformDone) {
    done(null, chunk);
  },
  flush(done: TransformDone) {
    console.log("flush");
    done(null, "!");
  },
});

const output: string[] = [];
transform.on("data", (chunk: Buffer) => output.push(chunk.toString()));
transform.on("end", () => console.log("result:", output.join("")));
transform.end("agent");
