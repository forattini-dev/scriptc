// A Duplex subclass forwarding checked-dynamic options through super keeps
// scalar options and falls back to its prototype _read/_write methods when
// the runtime options record does not provide callback properties.
import { Duplex } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

class AgentDuplex extends Duplex {
  reads = 0;

  constructor(options: Dynamic) {
    super(options);
  }

  _read(): void {
    this.reads++;
    if (this.reads === 1) this.push("source");
    else this.push(null);
  }

  _write(chunk: Buffer, encoding: string, done: () => void): void {
    console.log("write:", chunk.toString(), encoding);
    done();
  }
}

const duplex = new AgentDuplex({
  encoding: "utf8",
  readableHighWaterMark: 2,
  writableHighWaterMark: 3,
  allowHalfOpen: false,
});

console.log("hwm:", duplex.readableHighWaterMark, duplex.writableHighWaterMark);
console.log("half:", duplex.allowHalfOpen);
duplex.on("data", (chunk: string) => console.log("data:", typeof chunk, chunk));
duplex.on("finish", () => console.log("finished"));
duplex.on("end", () => {
  console.log("end:", duplex.reads);
  duplex.end("sink");
});
