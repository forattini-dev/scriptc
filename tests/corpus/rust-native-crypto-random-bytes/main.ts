import { randomBytes } from "node:crypto";

function randomBytesHelper(count: number = 16, encoding: BufferEncoding = "hex"): string {
  return randomBytes(count).toString(encoding);
}

const bytes = randomBytes(16);
console.log(Buffer.isBuffer(bytes), bytes.length);
console.log(randomBytesHelper().length, randomBytesHelper(9, "base64").length);
console.log(/^[0-9a-f]{32}$/.test(randomBytes(16).toString("hex")));
console.log(randomBytes(0).length);
const first = randomBytes(8).toString("hex");
const second = randomBytes(8).toString("hex");
console.log(first === second);
try {
  randomBytes(-1);
} catch (error) {
  console.log(error instanceof RangeError, (error as { code?: string }).code, (error as Error).message);
}
