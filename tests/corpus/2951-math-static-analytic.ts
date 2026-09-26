// The analytic Math functions compile without --dynamic. Compare ordinary
// values, special IEEE cases, variadic hypot, spreads, and argument order.
console.log(Math.sin(0), 1 / Math.sin(-0), Math.cos(0), Math.exp(0));
console.log(Math.sqrt(144), 1 / Math.sqrt(-0), Math.log(1), Math.log2(1024), Math.log10(1000));
console.log(Math.atan2(0, 1), 1 / Math.atan2(-0, 1), Math.atan2(1, 0));
console.log(Math.pow(2, 10), Math.pow(2, 0.5).toFixed(12), Math.pow(-2, 3), Math.pow(-2, 2));
console.log(Math.sin(1).toFixed(12), Math.cos(1).toFixed(12), Math.exp(1).toFixed(12));
console.log(Math.log(2).toFixed(12), Math.log2(3).toFixed(12), Math.log10(3).toFixed(12));
console.log(Math.atan2(1, 1).toFixed(12), Math.atan2(-1, -1).toFixed(12));

const nan = 0 / 0;
console.log(Math.sin(Infinity), Math.cos(-Infinity), Math.exp(-Infinity), Math.exp(Infinity));
console.log(Math.sqrt(-1), Math.log(0), Math.log(-1), Math.log2(0), Math.log10(-1));
console.log(Math.atan2(nan, 1), Math.pow(-1, Infinity), Math.pow(1, -Infinity), Math.pow(1, nan));
console.log(Math.pow(nan, 0), Math.pow(0, -1), 1 / Math.pow(-0, 3), Math.pow(-0, -3));

console.log(Math.hypot(), Math.hypot(-0), Math.hypot(3, 4), Math.hypot(2, 3, 6));
console.log(Math.hypot(nan, Infinity), Math.hypot(-Infinity, nan), Math.hypot(0, nan));
const large = Math.hypot(1e308, 1e308);
const tiny = Math.hypot(1e-300, 1e-300);
console.log(large > 1e308, large < Infinity, tiny > 1e-300, tiny < 2e-300);
const coords: number[] = [3, 4];
console.log(Math.hypot(...coords), Math.hypot(0, ...coords), Math.hypot(...coords, 12));
let order = "";
function next(label: string, value: number): number { order += label; return value; }
console.log(Math.hypot(next("a", 3), next("b", 4)), order);
