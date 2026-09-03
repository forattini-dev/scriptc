import { Writable } from "node:stream";

const seen: string[] = [];
const sink = new Writable({
  write(chunk, _encoding, done) {
    seen.push(chunk.toString());
    done();
  },
});

function writeUnion(chunk: string | Buffer): void {
  sink.write(chunk);
}

writeUnion("alpha");
writeUnion(Buffer.from("beta"));
sink.end(() => console.log(seen.join(",")));
