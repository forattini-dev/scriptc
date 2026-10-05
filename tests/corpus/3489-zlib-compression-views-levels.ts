// @rust-only
// @no-engine
// The fixed-level deflate forms borrow only the selected view and release it
// before the next alias write, like the default form (corpus 3144). Print
// decompressed bytes; corpus 3481 and 3487 pin the compressed bytes.
import { deflateSync, inflateSync } from "node:zlib";

function check(input: Uint8Array): void {
  console.log("level-1", inflateSync(deflateSync(input, { level: -1 })).toString("hex"));
  console.log("level0", inflateSync(deflateSync(input, { level: 0 })).toString("hex"));
  console.log("level9", inflateSync(deflateSync(input, { level: 9 })).toString("hex"));
}

const storage = new Uint8Array([99, 1, 2, 3, 4, 5, 6, 88]);
const view = storage.subarray(1, 7);
check(view);
storage[3] = 42;
check(view);
view[0] = 17;
console.log("alias", storage[1], storage[3], storage[0], storage[7]);
check(storage.subarray(4, 4));

const buffer = Buffer.from("xxborrowedyy");
const slice = buffer.subarray(2, 10);
console.log("buffer", inflateSync(deflateSync(slice, { level: 9 })).toString());
buffer[2] = 66;
console.log("updated", inflateSync(deflateSync(slice, { level: 0 })).toString());
console.log("preserved", buffer.toString());
