// @rust-only
// @no-engine
const large = 90071992547409931234567890n;
console.log("values", large, 0n, -0n, -123n, 0xffn, 0b101n, 1_000n);
console.log("constructor", BigInt("0x100"), BigInt(42), BigInt(true), BigInt(large));
console.log("math", large + 10n, large - 10n, 13n * 17n, -7n / 3n, -7n % 3n, 2n ** 80n);
console.log("text", String(large), `value=${large}`, "prefix:" + large, large.toString(), large.toString(16), large.toString(undefined));
function truth(value: bigint): boolean { return !!value; }
console.log("truth", truth(0n), truth(1n), !large, typeof large, typeof 0n);
function equal(a: any, b: any): boolean { return a === b; }
console.log("equal", equal(large, BigInt("90071992547409931234567890")), equal(1n, 1), equal(0n, false));
function less(a: any, b: any): boolean { return a < b; }
console.log("compare", large > 9007199254740992, 1n < 1.5, 2 > 1n, -2n < -1n, less(1n, "2"), less(1n, "invalid"), less(15n, "0x10"), less(0n, true), less(0n, null));
function describe(value: unknown): string { if (typeof value === "bigint") return value.toString(); return "other"; }
console.log("narrow", describe(large), describe("text"));
function erased(value: any, radix: any): any { return value.toString(radix); }
console.log("erased-method", String(erased(large, undefined)), String(erased(255n, "16")));
