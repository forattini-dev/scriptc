/// <reference lib="dom" />

const bytes = new Uint8Array([110, 97, 116, 105, 118, 101]);
const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
console.log(source);

try {
  new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([255]));
  console.log("missed");
} catch (error) {
  console.log(error instanceof TypeError);
}
