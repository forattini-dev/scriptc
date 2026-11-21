// @rust-only
// @no-engine
const encoder = new TextEncoder();
const other = new TextEncoder();
const alias = encoder;
console.log("codec", alias === encoder, alias === other);
const bytes = encoder.encode("ABCD");
const aliasBytes = bytes;
const copy = new Uint8Array(bytes);
const view = bytes.subarray(1, 3);
const slice = bytes.slice(1, 3);
console.log("codec", bytes === aliasBytes, bytes === copy, view === slice);
view.set(new Uint8Array([120, 121]));
console.log("codec", bytes.join(), copy.join(), view.join(), slice.join());
console.log("codec", view.byteOffset, view.byteLength);
const exactView = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
console.log("codec", exactView === view, exactView.join());
exactView[0] = 90;
console.log("codec", bytes.join(), exactView.join());
const holder = { encoder, bytes };
console.log("codec", holder.encoder === encoder, holder.bytes === bytes);
console.log("codec", new Uint8Array(3).join(), new Uint8Array().length);
console.log("codec", new Uint8Array([256, -1, 1.9, 513]).join());
const stored: unknown = bytes;
const checked = stored as Uint8Array;
console.log("codec", checked === bytes, checked.join());
const codec: unknown = encoder;
console.log("codec", (codec as TextEncoder) === encoder);
