// @rust-only
// @no-engine
const bytes = new Uint8Array(4);
const view = new DataView(bytes.buffer, 1, 2);
try { view.getUint32(0); }
catch (error) { if (error instanceof RangeError) console.log("read", error.message); }
try { view.setUint16(1, 42); }
catch (error) { if (error instanceof RangeError) console.log("write", error.message); }
try { new DataView(bytes.buffer, -1); }
catch (error) { if (error instanceof RangeError) console.log("offset", error.message); }
try { new DataView(bytes.buffer, 3, 2); }
catch (error) { if (error instanceof RangeError) console.log("length", error.message); }
console.log("edge", view.getUint16(0), view.byteOffset, view.byteLength);
