import assert from "node:assert/strict";

const a = 0x123456789abcdef0123456789abcdef0n;
const b = 0b101010101010101010101010101010101010101010101010101010101010101n;

console.log("literal-bases", a, b, 0o777777777777777777777n, 1_000_000_000_000_000_000n);
console.log("constructors", BigInt("  42  "), BigInt("+42"), BigInt("0xffffffffffffffff"), BigInt(false));
console.log("unicode-space", BigInt("\u00a0\u1680\u2028-42\u205f\u3000\ufeff"), BigInt("\ufeff\u2009"));
console.log("large-arith", a + b, a - b, a * b);
console.log("large-div", a / b, a % b, (a / b) * b + (a % b) === a);
console.log("negative-div", -a / b, -a % b, a / -b, a % -b);
console.log("negative-bits", ~a, -a & b, -a | b, -a ^ b);
console.log("word-shifts", a << 31n, a << 32n, a << 65n, a >> 65n, -a >> 65n);
console.log("reverse-shifts", a << -33n, a >> -33n);
console.log("powers", 2n ** 0n, (-3n) ** 21n, 10n ** 80n);
console.log("widths", BigInt.asUintN(1, -1n), BigInt.asIntN(1, 1n), BigInt.asUintN(65, -2n), BigInt.asIntN(65, (1n << 65n) - 1n));
console.log("radices", a.toString(2), a.toString(8), a.toString(16), a.toString(36));
console.log("numbers", Number((1n << 53n) + 1n), Number(10n ** 400n), BigInt(1e100));

assert.equal(a, a);
assert.deepEqual([1n, a], [1n, a]);
