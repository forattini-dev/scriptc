// Generate the native runtime's independent BigInt vectors with the pinned Node
// oracle. Hex fields preserve whitespace/error messages without TSV ambiguity.
const hex = value => Buffer.from(String(value)).toString("hex");
const row = (op, a, b, evaluate) => {
  let result;
  try { result = `ok:${evaluate()}`; }
  catch (error) { result = `error:${error.name}:${error.message}`; }
  console.log([op, hex(a), hex(b), hex(result)].join("\t"));
};
const values = [0n, 1n, -1n, 2n, -3n, 17n, -17n, 255n, -256n,
  9007199254740993n, -9007199254740993n, 2n ** 100n + 7n, -(2n ** 100n + 7n)];
const binary = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b,
  div: (a, b) => a / b, rem: (a, b) => a % b,
  and: (a, b) => a & b, or: (a, b) => a | b, xor: (a, b) => a ^ b,
  cmp: (a, b) => a < b ? -1 : a > b ? 1 : 0,
};
for (const a of values) {
  for (const b of values) for (const [op, fn] of Object.entries(binary)) row(op, a, b, () => fn(a, b));
  row("neg", a, "", () => -a);
  row("not", a, "", () => ~a);
  row("truthy", a, "", () => Boolean(a));
  row("number", a, "", () => Number(a));
  row("json", a, "", () => JSON.stringify(a));
  for (const b of [-129n, -65n, -1n, 0n, 1n, 5n, 64n, 129n, 10n ** 50n]) {
    row("shl", a, b, () => a << b);
    row("shr", a, b, () => a >> b);
  }
  for (const b of [-1, -0.5, 0, 1, 8, 8.9, 64, 65, 128, 2 ** 30 + 1, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    row("uint", a, b, () => BigInt.asUintN(b, a));
    row("int", a, b, () => BigInt.asIntN(b, a));
  }
  for (const b of [1, 2, 10, 16.9, 36, 37, NaN, Infinity]) row("radix", a, b, () => a.toString(b));
  for (const b of [-Infinity, -1e100, -1.5, -0.5, -0, 0.5, 1.5, 9007199254740992, 9007199254740994, 1e100, Infinity, NaN]) {
    row("cmpNumber", a, b, () => a < b ? -1 : a > b ? 1 : a == b ? 0 : "unordered");
  }
}
for (const a of [0n, 1n, -1n, 2n, -2n, 10n]) {
  for (const b of [-1n, 0n, 1n, 2n, 3n, 100n, 10n ** 50n]) row("pow", a, b, () => a ** b);
}
for (const a of ["", " ", "\ufeff42\u00a0", "\u008542", "\u200b42", "\u202842\u2029",
  "0", "+0", "-0", "+0017", "-0017", "0xff", "0XFF", "0b1010", "0o701",
  "+0xff", "-0xff", "0x", "0o8", "0b2", "1_000", "1.0", "1e3", "12n", "++1", "+", "-", "+ ", "- ", "--1", "1\n2", "Infinity", "１２", "\ud83d\ude00"]) {
  row("parse", a, "", () => BigInt(a));
}
for (const a of [0, -0, 1, -1, 1.5, Number.MIN_VALUE, NaN, Infinity, -Infinity,
  Number.MAX_SAFE_INTEGER, 9007199254740994, 1e100, -1e100, Number.MAX_VALUE]) {
  row("fromNumber", a, "", () => BigInt(a));
}
// Rounding ties, carry into the next exponent, and overflow to Infinity.
for (let exponent = 53n; exponent <= 1024n; exponent += 17n) {
  for (const delta of [-1n, 0n, 1n, (1n << (exponent - 53n)) - 1n, 1n << (exponent - 53n), (1n << (exponent - 53n)) + 1n]) {
    for (const sign of [1n, -1n]) {
      const a = sign * ((1n << exponent) + delta);
      row("number", a, "", () => Number(a));
    }
  }
}
