"use strict";

function readableStreamFrom(iterable) {
  let iterator;
  return new ReadableStream({
    start() {
      iterator = iterable[Symbol.asyncIterator]();
    },
    pull(controller) {
      return iterator.next().then(({ done, value }) => {
        if (done) {
          return queueMicrotask(() => {
            controller.close();
            controller.byobRequest?.respond(0);
          });
        }
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (buf.byteLength) {
          return controller.enqueue(new Uint8Array(buf));
        }
        return this.pull(controller);
      });
    },
    cancel() {
      return iterator.return();
    },
    type: "bytes",
  });
}

module.exports = { readableStreamFrom };
console.log("ready");
