// @rust-only
// @no-engine
export {};
console.log("round", (1.005).toFixed(2), (2.55).toFixed(1), (2.35).toFixed(1), (-2.5).toFixed(), (2.5).toFixed());
console.log("zeros", (-0).toFixed(3), (-0.0001).toFixed(2), (0).toFixed(5));
console.log("limits", (1e21).toFixed(4), (1e20).toFixed(2), Number.MIN_VALUE.toFixed(100));
console.log("special", Number.NaN.toFixed(2), Number.POSITIVE_INFINITY.toFixed(1), Number.NEGATIVE_INFINITY.toFixed());
console.log("precision", (0.1).toFixed(30), (1.2345).toFixed(100));
function fixed(value: number, digits?: number): string { return value.toFixed(digits); }
console.log("defaults", fixed(7.5), fixed(7.5, undefined), fixed(7.5, 2), fixed(1.25, 1.9));
const custom = { toFixed: (digits: number): string => "custom:" + digits };
console.log("shadow", custom.toFixed(7));
