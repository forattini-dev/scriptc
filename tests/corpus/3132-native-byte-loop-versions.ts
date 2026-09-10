import { Buffer } from "node:buffer";

function mix(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length);
  let read = 0;
  for (let i = 0; i < left.length; i++) {
    let value: number;
    if (i % 2 === 0) value = left[read++];
    else value = right[read++];
    out[i] = value + read + left.byteLength;
    if (i === 1) continue;
    if (i === 3) break;
    out[i] = out[i] + right[i];
  }
  return out;
}
const direct = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const words = new Uint32Array([0x04030201, 0x08070605]);
const backed = Buffer.from(words.buffer);
console.log("direct", mix(direct, direct).join(","));
console.log("backed", mix(backed, backed).join(","));
console.log("mixed", mix(direct, backed).join(","), mix(backed, direct).join(","));
console.log("aliases", mix(direct.subarray(0, 4), direct.subarray(2, 6)).join(","));
console.log("empty", mix(new Uint8Array(0), backed.subarray(0, 0)).length);
// Read the backed view through indexing: backed Buffer.join has a separate,
// pre-existing runtime defect, reproduced with the previous compiler too.
function contents(input: Uint8Array): string {
  let result = "";
  for (let i = 0; i < input.length; i++) {
    if (i > 0) result += ",";
    result += input[i];
  }
  return result;
}
console.log("inputs", contents(direct), contents(backed));

function throwing(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i];
    if (i === 1) throw new Error("leave specialized loop");
  }
  return out;
}
try { throwing(direct); } catch { direct[0] = 99; }
try { throwing(backed); } catch { backed[0] = 88; }
console.log("unwind", direct[0], backed[0]);
