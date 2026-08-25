// Native Number formatting: fixed and significant decimal digits plus
// Node-compatible representations in every explicit radix.
const n = 1234.5678;
console.log(n.toFixed(0), n.toFixed(2), n.toFixed(6));
console.log((0.1 + 0.2).toFixed(17), (-3.7).toFixed(1), (0).toFixed(2));
console.log((1e21).toFixed(2), (0 / 0).toFixed(2));
console.log(n.toPrecision(2), n.toPrecision(8), (0.000123).toPrecision(2));
console.log((255).toString(16), (255).toString(2), (511).toString(8), (12345).toString(36));
console.log((-255).toString(16), (0.5).toString(2));
console.log((0.1).toString(2), (0.1).toString(3), Math.PI.toString(36));
const digits = 3;
console.log(Math.PI.toFixed(digits));
console.log((12.5).toPrecision(), (12.5).toPrecision(undefined));
let evaluationOrder = "";
function numberReceiver(): number { evaluationOrder += "r"; return 12.5; }
function absentPrecision(): undefined { evaluationOrder += "a"; return undefined; }
console.log(numberReceiver().toPrecision(absentPrecision()), evaluationOrder);
function optionalPrecision(value: number | undefined): string { return (12.5).toPrecision(value); }
function optionalRadix(value: number | undefined): string { return (255).toString(value); }
console.log(optionalPrecision(undefined), optionalPrecision(3));
console.log(optionalRadix(undefined), optionalRadix(16));
try { console.log(optionalPrecision(101)); }
catch (error) { console.log(error instanceof RangeError, (error as Error).message); }
try { console.log(optionalRadix(37)); }
catch (error) { console.log(error instanceof RangeError, (error as Error).message); }
console.log((255).toString(16.9), Infinity.toString(16), NaN.toString(2));
for (const badPrecision of [0, 101, NaN]) {
  try { console.log((1).toPrecision(badPrecision)); }
  catch (error) { console.log(error instanceof RangeError, (error as Error).message); }
}
for (const badRadix of [1, 37, NaN, Infinity]) {
  try { console.log((1).toString(badRadix)); }
  catch (error) { console.log(error instanceof RangeError, (error as Error).message); }
}
const edgeNumbers = [
  5e-324,
  2.2250738585072014e-308,
  0.1,
  1 / 3,
  Math.PI,
  1.0000000000000002,
  9007199254740992,
  1.7976931348623157e308,
];
for (const value of edgeNumbers) {
  for (const radix of [2, 3, 7, 16, 36]) console.log(radix, value.toString(radix));
  for (const precision of [1, 2, 5, 17, 50, 100]) console.log(precision, value.toPrecision(precision));
}
// Results are ordinary static strings: length, concat, further island calls.
const hex = (48879).toString(16);
console.log(hex.length, hex.toUpperCase(), "0x" + hex);
