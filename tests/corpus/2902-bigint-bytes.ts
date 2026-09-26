const b = Buffer.alloc(24);

console.log("offsets", b.writeBigUInt64BE(0xffffffffffffffffn), b.writeBigInt64LE(-2n, 8));
console.log("reads", b.readBigUInt64BE(), b.readBigUint64BE(), b.readBigInt64LE(8));

b.writeBigUint64LE(0x0123456789abcdefn, 16);
console.log("hex", b.toString("hex"), b.readBigUInt64LE(16).toString(16));

const view = new DataView(b.buffer, 4, 16);
view.setBigUint64(0, 0xfedcba9876543210n);
view.setBigInt64(8, -1234567890123456789n, true);
console.log("view", view.getBigUint64(0).toString(16), view.getBigInt64(8, true));

view.setBigInt64(0, (1n << 80n) + 5n);
console.log("wrap", view.getBigInt64(0), view.getBigUint64(0));
