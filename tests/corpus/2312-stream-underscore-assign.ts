// The underscore-method assignment surface: `r._read = fn` / `w._write =
// fn` (and _final/_destroy) AFTER construction — Node's own-property
// shadow of the prototype method. An optionless Readable gains its _read;
// a Writable's assigned _write REPLACES the constructor option; `this`
// binds to the stream in function-expression bodies (Node's call shape);
// _final and _destroy ride the same slots.
import { Readable, Writable } from "node:stream";

const r = new Readable();
let pushed = 0;
r._read = function () {
  pushed++;
  if (pushed <= 2) this.push(`chunk${pushed}`);
  else this.push(null);
};
r._destroy = (error: Error | null, cb: (e?: Error | null) => void) => {
  console.log("read destroy ran", error === null);
  cb();
};
const got: string[] = [];
r.on("data", (c: Buffer) => got.push(c.toString()));
r.on("end", () => {
  console.log("read got", got.join("+"));

  const w = new Writable({
    write(chunk: Buffer, enc: string, cb: (e?: Error | null) => void) {
      console.log("old write ran (should not)");
      cb();
    },
  });
  w._write = (chunk: Buffer, enc: string, cb: (e?: Error | null) => void) => {
    console.log("write saw", chunk.toString(), enc);
    cb();
  };
  w._final = (cb: (e?: Error | null) => void) => {
    console.log("final ran");
    cb();
  };
  w._destroy = (error: Error | null, cb: (e?: Error | null) => void) => {
    console.log("destroy ran", error === null);
    cb();
  };
  w.write("hello");
  w.end(() => console.log("write finished"));
  w.on("close", () => {
    // _destroy assigned post-construction: autoDestroy consumes it after
    // 'finish'; the callback completes destruction ('close' already
    // scheduled — this runs before the next stream's lifecycle).
    console.log("closed");
  });
});
