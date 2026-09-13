// @rust-only
// @no-engine
function numeric(value) {
  console.log(Number(value), String(+value), String(-value), Boolean(value), typeof value);
  console.log(String(value - 2), String(value * 2), String(value / 2), String(value % 7), String(value ** 2));
  console.log(value < 13, value <= 12, value > 11, value >= 12);
}
numeric(new Date(12));
numeric(new Date(NaN));
let calls = 0;
function produce() { calls++; return new Date(0); }
console.log(produce() instanceof Date, calls);
