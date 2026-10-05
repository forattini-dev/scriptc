// @rust-only
// @no-engine
// A deflate stream that ends inside the first window slide (inputs of about
// 65274 to 65535 bytes) must match Node's bytes: zlib moves only the used part
// of the window, and the final match search reads the bytes left behind.
// Neighbouring sizes outside that range and one in the second slide range pin
// the boundaries. Every framing and the fixed level share the compressor.
import { crc32, deflateRawSync, deflateSync, gzipSync } from "node:zlib";

function generator(): () => number {
  let state = 0x2545f491;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

// Four letters: dense in short matches.
function alphaFour(length: number): Uint8Array {
  const next = generator();
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = 97 + (next() & 3);
  return data;
}

// Literals interleaved with copies of 3..32 bytes from up to 40000 back.
function copyHeavy(length: number): Uint8Array {
  const next = generator();
  const data = new Uint8Array(length);
  let at = 0;
  while (at < length) {
    if (at === 0 || next() % 5 === 0) {
      data[at++] = next() & 255;
    } else {
      const run = 3 + (next() % 30);
      const distance = 1 + (next() % Math.min(at, 40000));
      for (let i = 0; i < run && at < length; i++, at++) data[at] = data[at - distance]!;
    }
  }
  return data;
}

function report(label: string, input: Uint8Array): void {
  const level9 = deflateSync(input, { level: 9 });
  const normal = deflateSync(input);
  const raw = deflateRawSync(input);
  const gzip = gzipSync(input);
  console.log(label, "l9", level9.length, crc32(level9));
  console.log(label, "default", normal.length, crc32(normal));
  console.log(label, "raw", raw.length, crc32(raw));
  console.log(label, "gzip", gzip.length, crc32(gzip));
}

for (const length of [65273, 65283, 65540, 98100]) report(`alpha-${length}`, alphaFour(length));
for (const length of [65296, 65355, 65536, 98100]) report(`copy-${length}`, copyHeavy(length));
