// unshift() puts a chunk at the FRONT of the queue as its own entry, and
// repeated unshifts stack LIFO. What a reader then SEES of those
// boundaries depends on read(), which is pinned to
// NODE_COMPAT_MATRIX.primary (Node 24): a paused bare read() collapses the
// whole queue, so the ordering shows up in the concatenation order rather
// than as separate reads. read(n) still slices the unshifted head like any
// other, and 'data' events in flowing mode keep the entries apart.
//
// Under Node 26 (nodejs#60441) the bare reads below would come back one
// entry at a time instead. See the read() comments in the three runtimes.
import { Readable } from "node:stream";

const show = (c: Buffer | null): string => (c === null ? "null" : c.toString());

// The unshifted chunk lands ahead of the push()ed one behind it.
const front = new Readable({ read() {} });
front.push("bc");
front.unshift(Buffer.from("a"));
front.push(null);
console.log("front:", show(front.read()));
console.log("drained:", show(front.read()));

// Two unshifts come back out last-in-first-out: "a" then "b" then "c".
const lifo = new Readable({ read() {} });
lifo.push("c");
lifo.unshift(Buffer.from("b"));
lifo.unshift(Buffer.from("a"));
lifo.push(null);
console.log("lifo:", show(lifo.read()));
console.log("lifo-drained:", show(lifo.read()));

// Bytes pushed back after a partial read jump ahead of the head's
// remainder: "XY" precedes the "lo " that read(3) left behind.
const partial = new Readable({ read() {} });
partial.push("hello ");
partial.push("world");
console.log("partial:", show(partial.read(3)));
partial.unshift(Buffer.from("XY"));
partial.push(null);
console.log("pushed-back:", show(partial.read()));
console.log("drained:", show(partial.read()));

// unshift onto an empty queue is readable immediately.
const empty = new Readable({ read() {} });
empty.unshift(Buffer.from("z"));
empty.push(null);
console.log("empty:", show(empty.read()));
console.log("empty-drained:", show(empty.read()));

// read(n) slices an unshifted chunk like any other head, and the bare read
// after it takes the rest.
const sliced = new Readable({ read() {} });
sliced.push("de");
sliced.unshift(Buffer.from("abc"));
sliced.push(null);
console.log("sliced:", show(sliced.read(2)));
console.log("sliced-rest:", show(sliced.read()));
console.log("sliced-tail:", show(sliced.read()));

// Flowing mode keeps the entries apart, so the LIFO order is visible as
// three separate 'data' events.
const flow = new Readable({ read() {} });
flow.push("c");
flow.unshift(Buffer.from("b"));
flow.unshift(Buffer.from("a"));
flow.push(null);
const seen: string[] = [];
flow.on("data", (c: Buffer) => seen.push(c.toString()));
flow.on("end", () => console.log("flowing:", seen.join("|")));
