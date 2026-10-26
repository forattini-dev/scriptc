// @rust-only
// @no-engine
// @ts-nocheck
export {};
console.log("bigint", Number(0n), Number(-17n), Number(9007199254740993n), Number(9007199254740995n));
const huge = 10n ** 400n;
console.log("overflow", Number(huge) === Number.POSITIVE_INFINITY, Number(-huge) === Number.NEGATIVE_INFINITY);
function convert(value: bigint | string): number { return Number(value); }
console.log("union", convert(71n), convert("81"), Number.isSafeInteger(Number(9007199254740993n)));
try { [1, 2].slice(1n); } catch (error) { console.log("operator", error instanceof TypeError); }
const boxed = new Number(9007199254740993n);
console.log("boxed", boxed.valueOf(), typeof boxed, boxed !== new Number(9007199254740993n));
function wrap(value: bigint | undefined): Number { return new Number(value); }
console.log("boxed-union", wrap(41n).valueOf(), Number.isNaN(wrap(undefined).valueOf()));
let effects = "";
function ignored(): number { effects = "extra"; return 0; }
try { new Number(Symbol("bad"), ignored()); }
catch (error) { console.log("boxed-symbol", error instanceof TypeError, String(error.message), effects); }
