const huge = 1234567890123456789012345678901234567890n;
const other = 98765432109876543210987654321n;

console.log("literal", huge);
console.log("arith", huge + other, huge - other, 123456789n * 987654321n);
console.log("divmod", -100n / 9n, -100n % 9n);
console.log("pow", 3n ** 40n);
console.log("bits", (-12345678901234567890n & 0xffffffffffffffffn).toString(16));
console.log("shift", 1n << 100n, -9n >> 2n, 8n << -1n);
console.log("compare", huge > other, huge === BigInt("1234567890123456789012345678901234567890"));
console.log("mixed", 2n < 2.5, 2.5 > 2n, 2n < NaN, -3n < -2.5, 10n < Infinity);
console.log("convert", BigInt(9007199254740992), BigInt(true), Number(9007199254740993n));
console.log("width", BigInt.asUintN(8, -1n), BigInt.asIntN(8, 255n));
console.log("text", `${huge}`, huge.toString(36), typeof huge, Boolean(0n), Boolean(1n));
