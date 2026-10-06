// @no-engine
// A chunk the checker narrowed to Buffer may still be stored in a union with
// null and undefined; the decoder takes the Buffer arm like the plain forms.
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");

function threeArm(chunk: Buffer | null | undefined): string {
  if (chunk != null) return decoder.write(chunk);
  return "-";
}

function twoArm(chunk: Buffer | undefined): string {
  if (chunk !== undefined) return decoder.write(chunk);
  return "~";
}

function bytesArm(chunk: Uint8Array | null | undefined): string {
  if (chunk) return decoder.write(chunk as Buffer);
  return "_";
}

const euro = Buffer.from("€");
const queue: (Buffer | null | undefined)[] = [euro.subarray(0, 1), null, euro.subarray(1, 2), undefined, euro.subarray(2), Buffer.from("ok")];
for (const chunk of queue) console.log(JSON.stringify(threeArm(chunk)));
console.log(JSON.stringify(twoArm(euro.subarray(0, 2))), JSON.stringify(twoArm(undefined)), JSON.stringify(twoArm(euro.subarray(2))));
console.log(JSON.stringify(bytesArm(euro.subarray(0, 1))), JSON.stringify(bytesArm(null)), JSON.stringify(bytesArm(euro.subarray(1))));
console.log(JSON.stringify(decoder.end()));
