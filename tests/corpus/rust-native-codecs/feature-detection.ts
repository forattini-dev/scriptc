// @rust-only
// @no-engine
export {};

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const decoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
const bytes = encoder ? encoder.encode("ação") : new Uint8Array();
console.log(typeof TextEncoder, typeof TextDecoder, bytes.join(","));
console.log(decoder ? decoder.decode(bytes) : "missing");
