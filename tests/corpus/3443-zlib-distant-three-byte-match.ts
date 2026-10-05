// @rust-only
// @no-engine
import { deflateRawSync, inflateRawSync } from "node:zlib";

for (const distance of [4095, 4096, 4097, 8192]) {
  const input = Buffer.alloc(distance + 10);
  input[0] = 5;
  input[1] = 1;
  input[2] = 2;
  input[3] = 3;
  input[4] = 4;
  input[5] = 7;
  input[distance + 1] = 1;
  input[distance + 2] = 2;
  input[distance + 3] = 3;
  input[distance + 4] = 132;
  input[distance + 5] = 7;
  const packed = deflateRawSync(input);
  console.log(distance, packed.toString("hex"));
  console.log(inflateRawSync(packed).equals(input));
}
