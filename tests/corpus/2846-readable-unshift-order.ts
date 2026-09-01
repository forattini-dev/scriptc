// unshift() puts a chunk at the FRONT of the queue as its own entry: it
// never merges with what is already buffered, repeated unshifts stack
// LIFO, and the chunk pushed back after a partial read comes out ahead of
// that read's remainder.
import { Readable } from "node:stream";

const show = (c: Buffer | null): string => (c === null ? "null" : c.toString());

// The unshifted chunk stays separate from the push()ed one behind it.
const front = new Readable({ read() {} });
front.push("bc");
front.unshift(Buffer.from("a"));
front.push(null);
console.log("front:", show(front.read()));
console.log("behind:", show(front.read()));
console.log("drained:", show(front.read()));

// Two unshifts come back out last-in-first-out.
const lifo = new Readable({ read() {} });
lifo.push("c");
lifo.unshift(Buffer.from("b"));
lifo.unshift(Buffer.from("a"));
lifo.push(null);
console.log("lifo1:", show(lifo.read()));
console.log("lifo2:", show(lifo.read()));
console.log("lifo3:", show(lifo.read()));

// Pushing bytes back after a partial read jumps the head's remainder.
const partial = new Readable({ read() {} });
partial.push("hello ");
partial.push("world");
console.log("partial:", show(partial.read(3)));
partial.unshift(Buffer.from("XY"));
partial.push(null);
console.log("pushed-back:", show(partial.read()));
console.log("head-rest:", show(partial.read()));
console.log("tail:", show(partial.read()));
console.log("drained:", show(partial.read()));

// unshift onto an empty queue is readable immediately.
const empty = new Readable({ read() {} });
empty.unshift(Buffer.from("z"));
empty.push(null);
console.log("empty:", show(empty.read()));
console.log("empty-drained:", show(empty.read()));

// read(n) still slices an unshifted chunk like any other head.
const sliced = new Readable({ read() {} });
sliced.push("de");
sliced.unshift(Buffer.from("abc"));
sliced.push(null);
console.log("sliced:", show(sliced.read(2)));
console.log("sliced-rest:", show(sliced.read()));
console.log("sliced-tail:", show(sliced.read()));
