// @ts-nocheck
// @rust-only
// @no-engine
console.log("roots", Math.sqrt(16), Math.sqrt(-1), Math.sqrt(-0), 1 / Math.sqrt(-0), Math.cbrt(-8));
console.log("logs", Math.log(1), Math.log(0), Math.log(-1), Math.log2(8), Math.log10(100), Math.exp(0));
console.log("trig", Math.sin(0), 1 / Math.sin(-0), Math.cos(0), Math.tan(0), Math.asin(0), Math.acos(1), Math.atan(0));
console.log("atan2", Math.atan2(0, 1), 1 / Math.atan2(-0, 1), Math.atan2(0 / 0, 0), Math.atan2());
console.log("powers", Math.pow(2, 10), Math.pow(1, 1 / 0), Math.pow(0 / 0, 0), 1 / Math.pow(-0, 3), Math.pow(-0, -3));
console.log("hypot", Math.hypot(), Math.hypot(3, 4), Math.hypot(3, 4, 12), Math.hypot(0 / 0, 1 / 0), Math.hypot(-0));
console.log("scale", Math.hypot(3e200, 4e200), Math.hypot(3e-200, 4e-200));
console.log("convert", Math.sqrt("16"), Math.pow("2", true), Math.hypot(null, "3", "4"), Math.sqrt());
let trace = "";
function effect(label: string, value: number): number { trace = trace + label; return value; }
console.log("order", Math.pow(effect("a", 2), effect("b", 3), effect("c", 9)), trace);
// ECMAScript permits implementation approximations for transcendentals.
// Check nontrivial values to 12 decimal places as well as the exact edges above.
function decimal(value: number): number { return Math.round(value * 1e12) / 1e12; }
console.log("finite roots", decimal(Math.sqrt(2)), decimal(Math.cbrt(2)), decimal(Math.cbrt(-27)));
console.log("finite logs", decimal(Math.log(2)), decimal(Math.log2(3)), decimal(Math.log10(3)), decimal(Math.exp(1)));
console.log("finite trig", decimal(Math.sin(0.5)), decimal(Math.cos(0.5)), decimal(Math.tan(0.5)));
console.log("inverse trig", decimal(Math.asin(0.5)), decimal(Math.acos(0.5)), decimal(Math.atan(2)), decimal(Math.atan2(-3, -4)));
console.log("domains", Math.asin(2), Math.acos(-2), Math.sin(1 / 0), Math.tan(-1 / 0), Math.pow(-2, 0.5));
console.log("atan2 signs", decimal(Math.atan2(-0, -0)), decimal(Math.atan2(0, -0)), decimal(Math.atan2(1 / 0, 1 / 0)));
console.log("imul", Math.imul(0xffffffff, 5), Math.imul(0x7fffffff, 2), Math.imul(0x01000193, 0x811c9dc5));
console.log("callbacks", JSON.stringify([-2, -0, 3].map(Math.abs)), JSON.stringify([4, 9].map(Math.sqrt)));
