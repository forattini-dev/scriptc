import { Readable } from "node:stream";

class Source extends Readable {
  constructor() {
    super({ read: () => {} });
  }

  ping(): boolean {
    return this.emit("ready", 3);
  }
}

const source = new Source();
let seen = 0;
source.on("ready", (value: number) => { seen = value; });
console.log(source.ping(), seen, source instanceof Source, source instanceof Readable);
