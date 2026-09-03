// Duplex options forwarded through a checked-dynamic parameter configure both
// native halves and preserve read/write callbacks through the same object.
import { Duplex } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

function duplexFrom(options: Dynamic): Duplex {
  return new Duplex(options);
}

const streams: Duplex[] = [];
let reads = 0;
const duplex = duplexFrom({
  readableHighWaterMark: 2,
  writableHighWaterMark: 3,
  allowHalfOpen: false,
  read() {
    const target = streams[0];
    if (target === undefined) throw new Error("duplex read ran before construction finished");
    reads++;
    if (reads === 1) target.push("source");
    else target.push(null);
  },
  write(chunk: Buffer, encoding: string, done: () => void) {
    console.log("write:", chunk.toString(), encoding);
    done();
  },
});
streams.push(duplex);

console.log("hwm:", duplex.readableHighWaterMark, duplex.writableHighWaterMark);
console.log("half:", duplex.allowHalfOpen);
duplex.setEncoding("utf8");
duplex.on("data", (chunk: string) => console.log("data:", chunk));
duplex.on("finish", () => console.log("finished"));
duplex.on("end", () => {
  console.log("end:", reads);
  duplex.end("sink");
});
