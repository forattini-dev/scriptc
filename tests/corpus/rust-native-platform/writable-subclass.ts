import { Writable } from "node:stream";

class Sink extends Writable {
  constructor() {
    super({ write: (_chunk, _encoding, callback) => { callback(); } });
  }

  ping(): boolean {
    return this.emit("ready", 5);
  }
}

const sink = new Sink();
let seen = 0;
sink.on("ready", (value: number) => { seen = value; });
console.log(sink.ping(), seen, sink instanceof Sink, sink instanceof Writable);
