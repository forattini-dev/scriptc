function predict(a: number, b: number, c: number): number {
  const estimate = a + b - c;
  const da = Math.abs(estimate - a);
  const db = Math.abs(estimate - b);
  const dc = Math.abs(estimate - c);
  if (da <= db && da <= dc) return a;
  return db <= dc ? b : c;
}
const samples = new Uint8Array([0, 1, 2, 17, 63, 127, 128, 129, 200, 254, 255]);
let checksum = 0;
for (let a = 0; a < samples.length; a++) {
  for (let b = 0; b < samples.length; b++) {
    for (let c = 0; c < samples.length; c++) {
      checksum += predict(samples[a], samples[b], samples[c]);
    }
  }
}
console.log("prediction", checksum);
function difference(a: number, b: number): number { return a - b; }
let at = 0;
console.log("effects", difference(samples[at++], samples[at++]), at);
function mixed(value: number): number { return value + 7; }
console.log("mixed", mixed(samples[1]), mixed(0.25), mixed(Infinity), mixed(NaN));
function negativeZero(value: number): number { return value * -1; }
console.log("zero", 1 / negativeZero(0), 1 / negativeZero(-0));
function boundary(value: number): number { return value + 1; }
console.log("bounds", boundary(2147483647), boundary(-2147483648), boundary(9007199254740992));
function absolute(value: number): number { return Math.abs(value); }
console.log("abs", absolute(-2147483648), absolute(-0));
function escaped(value: number): number { return value * 3; }
const invoke = escaped;
console.log("escape", escaped(samples[2]), invoke(0.25));
function mutation(value: number): number { value = value / 2; return value + 1; }
console.log("mutation", mutation(samples[1]));
function branch(value: number, flag: boolean): number {
  const selected = flag ? value : 0.5;
  return selected + 1;
}
console.log("branch", branch(samples[1], true), branch(samples[1], false));
let changed = 1;
changed = 0.25;
console.log("changed", mixed(changed));

function product(a: number, b: number): number { return a * b; }
const byte = samples[10];
const signed = samples[0] - 128;
console.log("products", product(byte, byte), product(byte, 16777217), product(signed, samples[0]));
const exact = (byte - 128) * (samples[3] + 1);
console.log("derived", exact, exact === 2286, exact < 3000);
