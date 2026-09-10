// @no-engine
// Compression borrows only the selected view and releases it before the next
// alias write. Print decompressed bytes: compressed output is codec-dependent.
import {
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib";

function check(input: Uint8Array): void {
  console.log("default", inflateSync(deflateSync(input)).toString("hex"));
  console.log("level0", inflateSync(deflateSync(input, { level: 0 })).toString("hex"));
  console.log("level9", inflateSync(deflateSync(input, { level: 9 })).toString("hex"));
  console.log("raw", inflateRawSync(deflateRawSync(input)).toString("hex"));
  console.log("gzip", gunzipSync(gzipSync(input)).toString("hex"));
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
console.log("buffer", inflateSync(deflateSync(slice)).toString());
buffer[2] = 66;
console.log("updated", gunzipSync(gzipSync(slice)).toString());
console.log("preserved", buffer.toString());
