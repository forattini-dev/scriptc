// node:buffer.isUtf8 validates the bytes themselves, including rejection
// of truncated, overlong, surrogate, and out-of-range UTF-8 sequences.
import { isUtf8 } from "node:buffer";

for (const bytes of [
  Buffer.from("olá 😀"),
  Buffer.from([0xe2, 0x82]),
  Buffer.from([0xc0, 0xaf]),
  Buffer.from([0xed, 0xa0, 0x80]),
  Buffer.from([0xf4, 0x90, 0x80, 0x80]),
]) {
  console.log(isUtf8(bytes));
}
