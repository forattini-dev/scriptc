import { Writable } from "node:stream";

const sink = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});

function writeDynamic(chunk: any): void {
  sink.write(chunk);
}

try {
  writeDynamic(null);
} catch (error) {
  const streamError = error as NodeJS.ErrnoException;
  console.log(streamError.code, streamError.message);
}
