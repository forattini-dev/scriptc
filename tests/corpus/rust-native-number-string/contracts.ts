// @rust-only
// @no-engine
export {};
console.log("integer", Number.MAX_SAFE_INTEGER.toString(), (255).toString(16), (35).toString(36), (-31).toString(2));
console.log("fraction", (0.1).toString(2), (10.5).toString(16), (1 / 3).toString(3));
console.log("special", (-0).toString(), Number.NaN.toString(), Number.POSITIVE_INFINITY.toString(16), Number.NEGATIVE_INFINITY.toString());
console.log("decimal", (1e21).toString(), (1e-7).toString(), Number.MIN_VALUE.toString(10));
function format(value: number, radix?: number): string { return value.toString(radix); }
console.log("optional", format(31), format(31, 16), format(31, undefined), format(7, 2.9));
const custom = {toString: (radix: number): string => "custom:" + radix};
console.log("shadow", custom.toString(16));
