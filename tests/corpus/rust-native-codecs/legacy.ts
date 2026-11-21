const utf16le = new TextDecoder("utf-16");
const utf16be = new TextDecoder("utf-16be");
const windows = new TextDecoder("windows-1252");

console.log(
  "utf16le",
  utf16le.decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x3d, 0xd8, 0x00, 0xde])),
);
console.log("utf16be", utf16be.decode(new Uint8Array([0xfe, 0xff, 0x00, 0x41])));
console.log("windows", windows.decode(new Uint8Array([0x80, 0x20, 0x41])));
