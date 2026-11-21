// @rust-only
// @no-engine
// @ts-nocheck
var _a;

const fromCodePoint =
  (_a = String.fromCodePoint) !== null && _a !== void 0
    ? _a
    : function (codePoint) {
        let output = "";
        if (codePoint > 0xffff) {
          codePoint -= 0x10000;
          output += String.fromCharCode(((codePoint >>> 10) & 0x3ff) | 0xd800);
          codePoint = 0xdc00 | (codePoint & 0x3ff);
        }
        output += String.fromCharCode(codePoint);
        return output;
      };

console.log(fromCodePoint(65), fromCodePoint(0x1f600));
