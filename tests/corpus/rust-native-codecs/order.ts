// @rust-only
// @no-engine
let count = 0;
const encoder = new TextEncoder();
function receiver(): TextEncoder { count = count + 1; console.log("codec", "receiver", count); return encoder; }
function input(): string { console.log("codec", "input", count); return "\u2713"; }
console.log("codec", receiver().encode(input()).join());
console.log("codec", receiver().encoding);
const bytes = encoder.encode("abcd");
function byteReceiver(): Uint8Array { console.log("codec", "bytes"); return bytes; }
function start(): number { console.log("codec", "start"); return 1; }
function end(): number { console.log("codec", "end"); return 3; }
console.log("codec", byteReceiver().subarray(start(), end()).join());
const decoder = new TextDecoder();
function readDecoder(): TextDecoder { console.log("codec", "decoder"); return decoder; }
console.log("codec", readDecoder().decode(byteReceiver()));
