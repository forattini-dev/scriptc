// `extends Duplex` and `extends Transform`: the duplex echo (write-side
// override pushing into the read side), duplex options through super
// (allowHalfOpen), the transform override + _flush tail, and piping a
// subclass Readable through a subclass Transform.
import { Duplex, Readable, Transform } from "node:stream";

class Echo extends Duplex {
  constructor() {
    super({ allowHalfOpen: false });
  }
  _read(): void {}
  _write(chunk: Buffer, encoding: string, callback: () => void): void {
    this.push(chunk);
    callback();
  }
}
const e = new Echo();
console.log("halfOpen:", e.allowHalfOpen);
e.on("data", (c: Buffer) => console.log("echo:", c.toString()));
e.on("end", () => console.log("echo end"));
e.on("finish", () => console.log("echo finish"));
e.write("ping");
e.end("pong");

class Upper extends Transform {
  _transform(chunk: Buffer, encoding: string, callback: (error?: Error | null, data?: Buffer | string) => void): void {
    callback(null, chunk.toString().toUpperCase());
  }
  _flush(callback: (error?: Error | null, data?: Buffer | string) => void): void {
    callback(null, "!");
  }
}

class Words extends Readable {
  private words = ["alpha ", "beta ", "gamma"];
  private at = 0;
  _read(): void {
    if (this.at < this.words.length) this.push(this.words[this.at++]!);
    else this.push(null);
  }
}

const out: string[] = [];
const t = new Upper();
t.on("data", (c: Buffer) => out.push(c.toString()));
t.on("end", () => console.log("piped:", out.join("")));
new Words().pipe(t);

const direct = new Upper();
direct.on("data", (c: Buffer) => console.log("direct:", c.toString()));
console.log("direct push:", direct.push("manual"));
console.log("sync end");
