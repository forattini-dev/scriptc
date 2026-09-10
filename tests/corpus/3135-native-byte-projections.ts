import { Buffer } from "node:buffer";

function project(source: Uint8Array | null, count: number, use: boolean): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = use ? source![i] + source!.length : 7;
  return out;
}
const input = new Uint8Array([10, 20, 30, 40]);
console.log("direct", project(input, 4, true).join(","));
console.log("offset", project(input.subarray(1, 3), 2, true).join(","));
console.log("empty", project(null, 0, true).length);
console.log("unused", project(null, 2, false).join(","));
try { project(null, 1, true); } catch (error) { console.log("null", error instanceof TypeError); }
const words = new Uint32Array([0x04030201, 0x08070605]);
const backed = Buffer.from(words.buffer);
console.log("backed", project(backed, 8, true).join(","));

function aliases(a: Uint8Array | null, b: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) out[i] = a![i] + b![i];
  return out;
}
console.log("aliases", aliases(input, input).join(","));
console.log("mixed", aliases(input, backed).join(","));

let calls = 0;
function effect(source: Uint8Array | null): Uint8Array {
  calls++;
  source![0] = source![0] + 1;
  return source!;
}
function effects(source: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) out[i] = source![0] + effect(source)[0];
  return out;
}
console.log("effects", effects(input).join(","), calls, input[0]);
function replace(source: Uint8Array | null, other: Uint8Array): Uint8Array {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) { out[i] = source![0]; source = other; }
  return out;
}
console.log("replace", replace(input, new Uint8Array([99])).join(","));
function throwing(source: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) {
    out[i] = source![i];
    if (i === 1) throw new Error("release projection");
  }
  return out;
}
try { throwing(input); } catch { input[0] = 77; }
try { throwing(backed); } catch { backed[0] = 88; }
console.log("unwind", input[0], backed[0]);

function optional(source: Uint8Array | null | undefined, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = source![i];
  return out;
}
console.log("optional", optional(input, 2).join(","), optional(undefined, 0).length);
try { optional(undefined, 1); } catch (error) { console.log("undefined", error instanceof TypeError); }
function narrowed(source: Uint8Array | null): Uint8Array {
  if (source === null) return new Uint8Array(0);
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source[i];
  return out;
}
console.log("narrowed", narrowed(input).join(","), narrowed(null).length);
