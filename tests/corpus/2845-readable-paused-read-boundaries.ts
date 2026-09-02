// read() boundaries, pinned to NODE_COMPAT_MATRIX.primary (Node 24).
//
// Node's howMuchToRead(NaN) is `state.flowing && state.length ?
// state.buffer.first().length : state.length`, so a PAUSED bare read()
// collapses everything buffered into one value and only a FLOWING stream
// walks the queue one chunk at a time. read(n) slices across the pushed
// boundaries either way, and a read(n) larger than what is buffered stays
// null until EOF releases the remainder.
//
// Node 26 (nodejs#60441) makes the bare form return the head entry for any
// stream without a decoder. That is a primary promotion, not a bug fix:
// see the read() comments in scr_stream.c / 13-stream.js / readable.rs.
import { Readable } from "node:stream";

const show = (c: Buffer | null): string => (c === null ? "null" : c.toString());

// read(3) splits the head chunk; the bare read that follows takes ALL of
// what is left, across the boundary push() created.
const sliced = new Readable({ read() {} });
sliced.push("hello ");
sliced.push("world");
sliced.push(null);
console.log("slice:", show(sliced.read(3)));
console.log("rest:", show(sliced.read()));
console.log("drained:", show(sliced.read()));

// No prior read(n): one paused bare read drains the whole queue.
const walk = new Readable({ read() {} });
walk.push("aa");
walk.push("bb");
walk.push("cc");
walk.push(null);
console.log("walk1:", show(walk.read()));
console.log("walk2:", show(walk.read()));

// read(n) spanning a boundary leaves the remainder as the new head, and
// the bare read after it still collapses what remains.
const span = new Readable({ read() {} });
span.push("aa");
span.push("bb");
span.push("cc");
span.push(null);
console.log("span:", show(span.read(3)));
console.log("span-rest:", show(span.read()));
console.log("span-tail:", show(span.read()));

// A short read waits for EOF, then releases everything still buffered.
const short = new Readable({ read() {} });
short.push("aa");
short.push("bb");
console.log("short-open:", show(short.read(10)));
short.push(null);
console.log("short-eof:", show(short.read(10)));
console.log("short-drained:", show(short.read()));

// n exactly equal to the buffered length collapses the whole queue.
const exact = new Readable({ read() {} });
exact.push("aa");
exact.push("bb");
exact.push(null);
console.log("exact:", show(exact.read(4)));
console.log("exact-drained:", show(exact.read()));

// read(0) reads nothing and leaves the queue untouched.
const zero = new Readable({ read() {} });
zero.push("aa");
zero.push("bb");
zero.push(null);
console.log("zero:", show(zero.read(0)));
console.log("zero-after:", show(zero.read()));

// (A decoder-backed stream collapses the queue too — the one case Node 26
// keeps agreeing with Node 24 on. 1744-stream-set-encoding covers it; the
// Rust runtime does not implement read() on an encoded stream yet.)

// Draining inside a 'readable' handler is paused, so it takes one value.
const pull = new Readable({ read() {} });
pull.push("aa");
pull.push("bb");
pull.push("cc");
pull.push(null);
const pulled: string[] = [];
pull.on("readable", () => {
  let c: Buffer | null;
  while ((c = pull.read()) !== null) pulled.push(c.toString());
});
pull.on("end", () => {
  console.log("readable-pull:", pulled.join("|"));

  // FLOWING is the half of the rule that DOES walk the queue: every
  // pushed chunk arrives as its own 'data' event.
  const flow = new Readable({ read() {} });
  flow.push("aa");
  flow.push("bb");
  flow.push("cc");
  flow.push(null);
  const flowed: string[] = [];
  flow.on("data", (c: Buffer) => flowed.push(c.toString()));
  flow.on("end", () => console.log("flowing-data:", flowed.join("|")));
});
