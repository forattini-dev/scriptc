import { deflateSync, inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";

const data = Buffer.from("hello from scriptc", "utf8");
const normal = deflateSync(data);
const strong = deflateSync(data, { level: 9 });
const restored = inflateSync(strong);
console.log("buffers", Buffer.isBuffer(normal), Buffer.isBuffer(strong), Buffer.isBuffer(restored));
console.log("default", normal.toString("hex"));
console.log("strong", strong.toString("hex"));
console.log("restored", restored.toString("utf8"));
const view = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4);
const inflatedView = inflateSync(deflateSync(view, { level: 0 }));
console.log("view", inflatedView.toString("hex"));


try {
  inflateSync(new Uint8Array([0, 0]));
} catch (error) {
  if (error instanceof Error) console.log("invalid", error.name, error.message);
}
function badHeader(bytes: Uint8Array): void {
  try { inflateSync(bytes); }
  catch (error) { if (error instanceof Error) console.log("header", error.message); }
}
badHeader(new Uint8Array([1, 1]));
badHeader(new Uint8Array([136, 28]));
badHeader(new Uint8Array([120, 156]));

const scanlines = new Uint8Array([4,255,0,0,255,1,255,0,0,4,1,0,255,0,255,0,0,0]);
console.log("png-level9", deflateSync(scanlines, { level: 9 }).toString("hex"));
