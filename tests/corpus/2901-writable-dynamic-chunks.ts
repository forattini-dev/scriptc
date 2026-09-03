import { Writable } from "node:stream";

const seen: string[] = [];
const sink = new Writable({
  write(chunk, _encoding, done) {
    seen.push(chunk.toString());
    done();
  },
});

function writeDynamic(chunk: any): void {
  sink.write(chunk);
}

writeDynamic("alpha");
writeDynamic(Buffer.from("beta"));
sink.end(() => console.log(seen.join(",")));
