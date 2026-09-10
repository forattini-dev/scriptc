// @no-engine
// Exercise every binary64 exponent, both signs and mantissa boundaries.
// Node is the oracle for bit operators and typed-array write coercion.
const memory = new Uint8Array(8);
const view = new DataView(memory.buffer);
const word = new Uint32Array(1);
const byte = new Uint8Array(1);
const highMantissa = [0, 0, 0x0007ffff, 0x00080000, 0x000fffff, 0x000fffff];
const lowMantissa = [0, 1, 0xffffffff, 0, 0xfffffffe, 0xffffffff];
let signedHash = 0;
let unsignedHash = 0;
let byteHash = 0;
for (let exponent = 0; exponent < 2048; exponent++) {
  for (let sign = 0; sign < 2; sign++) {
    for (let mantissa = 0; mantissa < highMantissa.length; mantissa++) {
      view.setUint32(0, (sign * 0x80000000) + (exponent * 0x100000) + highMantissa[mantissa], false);
      view.setUint32(4, lowMantissa[mantissa], false);
      const value = view.getFloat64(0, false);
      signedHash = (((signedHash << 5) - signedHash) + (value | 0)) | 0;
      word[0] = value;
      byte[0] = value;
      unsignedHash = (((unsignedHash << 5) - unsignedHash) + word[0] + (value >>> 7)) >>> 0;
      byteHash = (((byteHash << 5) - byteHash) + byte[0]) | 0;
    }
  }
  if (exponent % 16 === 15) console.log(exponent, signedHash, unsignedHash, byteHash);
}
