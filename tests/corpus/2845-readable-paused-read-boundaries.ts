// Node's howMuchToRead(): a bare read() on a raw Buffer stream hands back
// exactly ONE queued chunk (state.buffer.first().length), never the whole
// queue, so the boundaries push() created survive the read. read(n) still
// slices across those boundaries, and a read(n) larger than what is
// buffered stays null until EOF releases the remainder.
import { Readable } from "node:stream";

const show = (c: Buffer | null): string => (c === null ? "null" : c.toString());

// read(3) splits the head chunk; the bare reads that follow walk the queue
// one chunk at a time: "lo " (the head's remainder), then "world".
const sliced = new Readable({ read() {} });
sliced.push("hello ");
sliced.push("world");
sliced.push(null);
console.log("slice:", show(sliced.read(3)));
console.log("head-rest:", show(sliced.read()));
console.log("next-chunk:", show(sliced.read()));
console.log("drained:", show(sliced.read()));

// No prior read(n): every bare read still yields a single pushed chunk.
const walk = new Readable({ read() {} });
walk.push("aa");
walk.push("bb");
walk.push("cc");
walk.push(null);
console.log("walk1:", show(walk.read()));
console.log("walk2:", show(walk.read()));
console.log("walk3:", show(walk.read()));
console.log("walk4:", show(walk.read()));

// read(n) spanning a boundary leaves the remainder as the new head.
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
