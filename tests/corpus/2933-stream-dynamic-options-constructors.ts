// Constructor options forwarded through an any-typed parameter are runtime
// data. Both stream constructors must inspect that checked-dynamic record and
// preserve Node's scalar option defaults. Assigned underscore methods keep
// callback behavior independent from the dynamic-callback boxing contract.
import { Readable, Writable } from "node:stream";

type Dynamic = ReturnType<typeof JSON.parse>;

function readableFrom(options: Dynamic): Readable {
  return new Readable(options);
}

function writableFrom(options: Dynamic): Writable {
  return new Writable(options);
}

let pushed = false;
const readable = readableFrom({
  encoding: "utf8",
  highWaterMark: 3,
  autoDestroy: false,
});
readable._read = () => {
  if (pushed) return;
  pushed = true;
  readable.push("dynamic");
  readable.push(null);
};

console.log("rhwm:", readable.readableHighWaterMark);
readable.on("data", (chunk: string) => console.log("data:", typeof chunk, chunk));
readable.on("end", () => {
  const writable = writableFrom({
    highWaterMark: 4,
    emitClose: false,
  });
  writable._write = (_chunk: Buffer, _encoding: BufferEncoding, done: () => void) => {
    console.log("write: dynamic");
    done();
  };
  console.log("whwm:", writable.writableHighWaterMark);
  writable.end("sink", () => console.log("done"));
});
