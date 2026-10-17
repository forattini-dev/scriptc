// @rust-only
// @no-engine
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function encodeWith(codec: TextEncoder, text: string): Uint8Array { return codec.encode(text); }
function decodeWith(codec: TextDecoder, bytes: Uint8Array): string { return codec.decode(bytes); }
const bytes = encodeWith(encoder, "a\u00e7\u00e3o \u{1f30d}\0");
console.log("codec", encoder.encoding, decoder.encoding, decoder.fatal, decoder.ignoreBOM);
console.log("codec", bytes.length, bytes.byteLength, bytes.byteOffset, bytes.join("-"));
console.log("codec", decodeWith(decoder, bytes));
console.log("codec", encoder.encode().length, decoder.decode());
const invalid = new Uint8Array([0xef, 0xbb, 0xbf, 65, 0xc0, 0xaf, 0xff]);
console.log("codec", decoder.decode(invalid));
const bom = encoder.encode("\ufefffirst\ufefflast");
console.log("codec", decoder.decode(bom));
console.log("codec", decoder.decode(bom), decoder.decode(bom));
