// The remaining one-argument Math functions compile without --dynamic.
// Transcendental results round before comparison because libm and V8 can
// differ in the last ulp; IEEE special values and signed zero compare raw.
const nan = 0 / 0;
console.log(Math.tan(0), 1 / Math.tan(-0), Math.tan(Infinity), Math.tan(nan));
console.log(Math.asin(0), 1 / Math.asin(-0), Math.asin(2), Math.asin(nan));
console.log(Math.acos(1), Math.acos(2), Math.acos(-2), Math.acos(nan));
console.log(Math.atan(0), 1 / Math.atan(-0), Math.atan(nan));
console.log(Math.cbrt(0), 1 / Math.cbrt(-0), Math.cbrt(Infinity), Math.cbrt(-Infinity), Math.cbrt(nan));
console.log(Math.sign(-42), 1 / Math.sign(-0), 1 / Math.sign(0), Math.sign(42), Math.sign(Infinity), Math.sign(-Infinity), Math.sign(nan));
console.log(Math.tan(1).toFixed(9), Math.asin(0.5).toFixed(9), Math.acos(0.5).toFixed(9));
console.log(Math.atan(1).toFixed(9), Math.cbrt(2).toFixed(9), Math.cbrt(-27).toFixed(9));
console.log(Math.asin(1).toFixed(9), Math.asin(-1).toFixed(9), Math.acos(-1).toFixed(9), Math.atan(Infinity).toFixed(9));
let seen = "";
function input(label: string, value: number): number { seen += label; return value; }
console.log(Math.sign(input("s", -8)), Math.cbrt(input("c", -8)), Math.atan(input("a", 1)).toFixed(9), seen);
