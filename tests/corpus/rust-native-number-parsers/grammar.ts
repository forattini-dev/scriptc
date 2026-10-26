// @rust-only
// @no-engine
const cases = [
  { text: "  +0Xfftail", radix: 0 }, { text: "-0x10", radix: 16 },
  { text: "0xff", radix: 10 }, { text: "0b11", radix: 0 },
  { text: "z!", radix: 36 }, { text: "00077", radix: 8 },
  { text: "10", radix: 1 }, { text: "10", radix: 37 },
  { text: "10", radix: 4294967298 }, { text: "10", radix: -4294967294 },
  { text: "10", radix: 2.9 }, { text: "10", radix: Number.POSITIVE_INFINITY },
  { text: "\uFEFF\u00A0\u2028-12end", radix: 10 },
  { text: "\u200B12", radix: 10 }, { text: "\u008512", radix: 10 },
  { text: "123456789012345678901234567890123456789", radix: 10 },
  { text: "1000000000000000000000000000000000000000000000000000011", radix: 2 },
  { text: "123456789abcdef123456789abcdef", radix: 16 },
  { text: "0x", radix: 0 }, { text: "-", radix: 10 },
];
for (let index = 0; index < cases.length; index = index + 1) {
  const entry = cases[index];
  console.log("integer", index, Number.parseInt(entry.text, entry.radix));
}
const floats = ["", ".5tail", "1.tail", "+.5", "-0tail", "1e", "1e+", "1e-2tail", "1.25e3x", "Infinitytail", "-Infinity!", "infinity", "0x20", "\uFEFF2.5end", "\u200B2.5", "5e-324", "1e309", "1_000"];
for (let index = 0; index < floats.length; index = index + 1) {
  console.log("float", index, Number.parseFloat(floats[index]));
}
