// @rust-only
// @no-engine
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";

const compress = promisify(deflateRaw);
const decompress = promisify(inflateRaw);
for (const text of [
  "abc".repeat(88),
  "abc".repeat(89),
  "hello ☃".repeat(31),
  "hello ☃".repeat(64),
  "hello hello hello hello compression works ☃ ".repeat(16),
]) {
  const packed = await compress(Buffer.from(text), { level: 6 });
  console.log(packed.toString("hex"));
  const unpacked = await decompress(packed);
  console.log(unpacked.toString("utf8") === text);
}
