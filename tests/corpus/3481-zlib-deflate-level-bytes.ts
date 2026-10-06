// @rust-only
// @no-engine
// Fixed-level deflateSync must reproduce Node's bytes, not merely round-trip.
// Short inputs print their whole stream; long ones print length and CRC-32.
import { crc32, deflateSync } from "node:zlib";

function hex(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += (bytes[i]! < 16 ? "0" : "") + bytes[i]!.toString(16);
  return text;
}

function short(name: string, input: Uint8Array): void {
  console.log(name, "l9", hex(deflateSync(input, { level: 9 })));
  console.log(name, "l0", hex(deflateSync(input, { level: 0 })));
  console.log(name, "l-1", hex(deflateSync(input, { level: -1 })));
}

function long(name: string, input: Uint8Array): void {
  const best = deflateSync(input, { level: 9 });
  const stored = deflateSync(input, { level: 0 });
  const normal = deflateSync(input, { level: -1 });
  console.log(name, "l9", best.length, crc32(best));
  console.log(name, "l0", stored.length, crc32(stored));
  console.log(name, "l-1", normal.length, crc32(normal));
}

let state = 0x2545f491;
function next(): number {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state;
}

// Literals interleaved with copies of 3..32 bytes from up to 40000 back.
function copyHeavy(length: number): Uint8Array {
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

function farMatch(distance: number): Uint8Array {
  const data = new Uint8Array(distance + 10);
  data[0] = 5;
  const first = [1, 2, 3, 4, 7];
  const second = [1, 2, 3, 132, 7];
  for (let i = 0; i < 5; i++) {
    data[1 + i] = first[i]!;
    data[distance + 1 + i] = second[i]!;
  }
  return data;
}

function paethRows(width: number, height: number): Uint8Array {
  const stride = width * 4;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * stride + x * 4;
      pixels[at] = (x * 255 / width + (next() & 3)) & 255;
      pixels[at + 1] = (y * 255 / height + (next() & 3)) & 255;
      pixels[at + 2] = ((x + y) * 127 / (width + height) + 40) & 255;
      pixels[at + 3] = 255;
    }
  }
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * (stride + 1) + 1 + x] = (pixels[y * stride + x]! - predicted) & 255;
    }
  }
  return out;
}

short("empty", new Uint8Array(0));
short("tail", new Uint8Array([2, 0, 3, 2, 0, 3, 2]));
short("hash", new Uint8Array([0x82, 0xf9, 0x04, 0x93, 0xd6, 0xf9, 0x04, 0x93, 0x56]));
short("hash9", Buffer.from("l fi fi"));
short("chain", Buffer.from("n tree tref tree"));
short("repeat", Buffer.from("abc".repeat(89)));
short("far4097", farMatch(4097));
short("far8192", farMatch(8192));
console.log("string", hex(deflateSync("héllo wörld ".repeat(7), { level: 9 })));
long("copy-20k", copyHeavy(20000));
long("copy-300k", copyHeavy(300000));
long("paeth-128x96", paethRows(128, 96));
long("zeros-100k", new Uint8Array(100000));
