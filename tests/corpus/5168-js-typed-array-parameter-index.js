// @ts-nocheck
function writeU32BE(buf, value, offset) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function chunk(data) {
  const bytes = new Uint8Array(12 + data.length);
  writeU32BE(bytes, data.length, 0);
  writeU32BE(bytes, 0x12345678, 8 + data.length);
  return bytes;
}

const bytes = chunk(new Uint8Array(2));
console.log(`${bytes[0]},${bytes[3]},${bytes[10]},${bytes[13]}`);
