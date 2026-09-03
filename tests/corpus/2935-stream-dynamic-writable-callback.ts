// A write callback nested in dynamic constructor options keeps its typed
// Buffer/string/completion boundary and completes the native write exactly
// once through the checked-dynamic adapter.
import { Writable } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

function writableFrom(options: Dynamic): Writable {
  return new Writable(options);
}

const writable = writableFrom({
  write(chunk: Buffer, encoding: string, done: () => void) {
    console.log("write:", chunk.toString(), encoding);
    done();
  },
});

writable.end("dynamic sink", () => console.log("finished"));
