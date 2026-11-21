const source = new Uint8Array([1, 2, 3, 4]);
const view = source.subarray(1, 3);
const buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
console.log(buffer.toString("hex"));
view[0] = 9;
console.log(buffer.toString("hex"));
