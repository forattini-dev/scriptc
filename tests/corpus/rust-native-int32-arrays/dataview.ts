// @rust-only
// @no-engine
const numbers = new Int32Array([0, 0]);
const view = new DataView(numbers.buffer);
view.setInt32(0, -123456, true);
view.setUint32(4, 4294967295, true);
console.log("view", view.getInt32(0, true), view.getUint32(4, true), numbers.join(), view.byteLength);
numbers[0] = 0x01020304;
console.log("reverse", view.getInt32(0, true), view.getUint8(0));
