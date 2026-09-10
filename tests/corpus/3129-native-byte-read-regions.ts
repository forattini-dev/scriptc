import { Buffer } from "node:buffer";

function difference(a: number, b: number): number { return Math.abs(a - b); }
function combine(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length);
  let index = 0;
  for (let i = 0; i < left.length; i++) {
    out[i] = difference(left[index++], right[i]) + index;
    if (i > 0) out[i] = out[i] + out[i - 1];
  }
  return out;
}
const base = new Uint8Array([10, 20, 30, 40]);
console.log("same", combine(base, base).join(","));
console.log("views", combine(base.subarray(1, 3), base.subarray(0, 2)).join(","));
const words = new Uint32Array([0x04030201, 0x08070605]);
const raw = Buffer.from(words.buffer);
console.log("backed", combine(raw, raw).join(","));

function mutate(data: Uint8Array, index: number): number {
  data[index] = data[index] + 10;
  return data[index];
}
function throughCall(input: Uint8Array, alias: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] + mutate(alias, i) + input[i];
  return out;
}
console.log("call alias", throughCall(base, base).join(","), base.join(","));
function throughWrite(input: Uint8Array, alias: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    alias[i] = alias[i] + 1;
    out[i] = input[i];
  }
  return out;
}
console.log("write alias", throughWrite(base, base).join(","));

function replacement(): Uint8Array {
  let input = new Uint8Array([1, 2]);
  const other = new Uint8Array([7, 8]);
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) { out[i] = input[i]; input = other; }
  return out;
}
console.log("replace", replacement().join(","));
function captured(input: Uint8Array): Uint8Array {
  function change(): number { input[0] = input[0] + 1; return input[0]; }
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) out[i] = input[0] + change();
  return out;
}
console.log("capture", captured(new Uint8Array([2])).join(","));

function fail(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i];
    if (i === 1) throw new Error("leave region");
  }
  return out;
}
try { fail(base); } catch { base[0] = 99; }
console.log("unwind", base.join(","));
