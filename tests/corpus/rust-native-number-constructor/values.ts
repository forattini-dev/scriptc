// @rust-only
// @no-engine
export {};
function show(label: string, value: any): void { console.log("value", label, Number(value)); }
console.log("missing", Number(), 1 / Number() === Number.POSITIVE_INFINITY);
show("number", 17.25); show("true", true); show("false", false); show("null", null);
console.log("undefined", Number.isNaN(Number(undefined)));
show("empty", ""); show("spaces", " \t\r\n"); show("decimal", " 42.5 ");
show("binary", "0b101"); show("octal", "0o17"); show("hex", "0xff");
show("exponent", "-1.25e3"); show("infinity", "Infinity"); show("negative-infinity", "-Infinity");
console.log("invalid", Number.isNaN(Number("12px")), Number.isNaN(Number("+0x10")), Number.isNaN(Number("NaN")));
console.log("negative-zero", 1 / Number("-0") === Number.NEGATIVE_INFINITY, 1 / Number(-0) === Number.NEGATIVE_INFINITY);
show("unicode-space", "\u00a0\u202f12\ufeff");
