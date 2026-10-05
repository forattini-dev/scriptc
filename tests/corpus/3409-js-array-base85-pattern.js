// @rust-only
// @no-engine

// Preserve the unannotated allocation/write/join pattern from @baldim/core.
const alphabet = "!#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~";
// The original package's public declaration supplies this byte-array ABI.
/** @param {Uint8Array} buf */
function encodeBase85(buf) {
  const len = buf.length;
  if (len === 0) return "";
  const fullGroups = Math.floor(len / 4);
  const remainder = len % 4;
  const chars = new Array(fullGroups * 5 + (remainder ? remainder + 1 : 0));
  let ci = 0;
  for (let i = 0; i < fullGroups * 4; i += 4) {
    let val = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
    for (let j = 4; j >= 0; j--) {
      chars[ci + j] = alphabet[val % 85];
      val = Math.floor(val / 85);
    }
    ci += 5;
  }
  if (remainder > 0) {
    let val = 0;
    const offset = fullGroups * 4;
    for (let i = 0; i < remainder; i++) val = val * 256 + buf[offset + i];
    for (let i = 0; i < 4 - remainder; i++) val = val * 256;
    const group = new Array(5);
    for (let j = 4; j >= 0; j--) {
      group[j] = alphabet[val % 85];
      val = Math.floor(val / 85);
    }
    for (let i = 0; i < remainder + 1; i++) chars[ci++] = group[i];
  }
  return chars.join("");
}
function verify(hex) {
  console.log(hex, encodeBase85(Buffer.from(hex, "hex")));
}
verify("");
verify("00");
verify("ff");
verify("0001");
verify("ffff");
verify("000102");
verify("ffffff");
verify("00010203");
verify("ffffffff");
verify("0001020304");
verify("000102030405");
verify("00010203040506");
verify("0001020304050607");
verify("000102030405060708");
verify("68656c6c6f20e29883");
