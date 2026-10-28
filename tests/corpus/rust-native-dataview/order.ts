// @rust-only
// @no-engine
const bytes = new Uint8Array(8);
function owner(): Uint8Array { console.log("owner"); return bytes; }
function offset(): number { console.log("offset"); return 1; }
function length(): number { console.log("length"); return 4; }
function value(): number { console.log("value"); return 4660; }
function little(): boolean { console.log("little"); return true; }
function view(): DataView {
  console.log("view");
  return new DataView(owner().buffer, offset(), length());
}
view().setUint16(offset(), value(), little());
console.log("bytes", bytes.join());
console.log("get", view().getUint16(offset(), little()));
