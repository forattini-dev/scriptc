// @rust-only
// @no-engine
function makeView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function read(view: DataView): number { return view.getUint32(0); }
const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const view = makeView(bytes.subarray(1, 7));
const alias = view;
const separate = makeView(bytes.subarray(1, 7));
console.log("identity", alias === view, alias === separate);
console.log("view", read(alias), view.getUint16(0, true), view.byteOffset, view.byteLength);
alias.setUint16(2, 0x1234, true);
console.log("shared", bytes.join(), view.getUint16(2), view.getUint16(2, true));
view.setInt8(0, -3);
console.log("signed", alias.getInt8(0), alias.getUint8(0), bytes.join());
