// Exercise runtime operands as well as constant divisors, which LLVM can
// lower differently. Reciprocals make the sign of zero observable.
function report(value: number): void {
  console.log(value, value === 0 ? 1 / value : 0);
}

function assigned(dividend: number, divisor: number): number {
  dividend %= divisor;
  return dividend;
}

function constants(value: number): void {
  report(value % 8);
  report(value % -8);
  report(value % 3);
  report(value % 0.1);
  report(value % 0.5);
  report(value % 1);
  report(value % 2.2250738585072014e-308);
  report(value % 5e-324);
  report(value % 0);
  report(value % -0);
  report(value % Infinity);
  report(value % -Infinity);
  report(value % NaN);
}

const values = [
  0, -0, 1, -1, 8, -8, 16, -16, 7.999999999999999,
  8.000000000000002, 17.25, -17.25, 0.1, -0.1,
  5e-324, -5e-324, 1.5e-323, -1.5e-323,
  2.225073858507201e-308, 2.2250738585072014e-308,
  -2.2250738585072014e-308, 1e-300, -1e-300,
  9007199254740991, -9007199254740991, 9007199254740992,
  1e100, -1e100, 1.7976931348623157e308, -1.7976931348623157e308,
  Infinity, -Infinity, NaN,
];
for (const dividend of values) {
  constants(dividend);
  for (const divisor of values) {
    report(dividend % divisor);
    report(assigned(dividend, divisor));
  }
}

let trace = "";
function left(): number { trace += "left "; return -17.25; }
function right(): number { trace += "right "; return 8; }
report(left() % right());
console.log(trace);

const target = [-16];
function index(): number { trace += "index "; return 0; }
trace = "";
report(target[index()] %= right());
report(target[0]);
console.log(trace);
