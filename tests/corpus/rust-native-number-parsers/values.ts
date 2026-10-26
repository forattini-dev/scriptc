// @ts-nocheck
// @rust-only
// @no-engine
console.log("basic", Number.parseInt("12"));
const values: any[] = [undefined, null, true, false, 42.9, -42.9, 0, -0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 1e21, 1e-7, 12345678901234567890n, "08", "-0tail", "0x20", "0b11", "12.5tail"];
for (let index = 0; index < values.length; index = index + 1) {
  const value = values[index];
  console.log("value", index, Number.parseInt(value), parseInt(value), Number.parseFloat(value), parseFloat(value));
}
console.log("missing", parseInt(), Number.parseInt(), parseFloat(), Number.parseFloat());
console.log("radix", parseInt("101", 2), parseInt("ff", "16"), parseInt("11", true), parseInt("11", null), parseInt("11", undefined));
console.log("undefined text", parseInt(undefined, 36), parseInt(false, 36));
console.log("negative zero", 1 / parseInt("-0"), 1 / parseFloat("-0"));
