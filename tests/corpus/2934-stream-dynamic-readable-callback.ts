// A callback nested in an options record must survive the typed-to-dynamic
// boundary and be installed by Readable's runtime option walk.
import { Readable } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

function readableFrom(options: Dynamic): Readable {
  return new Readable(options);
}

const streams: Readable[] = [];
let reads = 0;
const readable = readableFrom({
  read() {
    reads++;
    const target = streams[0];
    if (target === undefined) throw new Error("stream callback ran before construction finished");
    target.push(reads === 1 ? "from callback" : null);
  },
});
streams.push(readable);

readable.setEncoding("utf8");
readable.on("data", (chunk: string) => console.log("data:", chunk));
readable.on("end", () => console.log("reads:", reads));
