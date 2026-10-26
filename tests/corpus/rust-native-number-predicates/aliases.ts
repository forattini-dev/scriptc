// @rust-only
// @no-engine
export {};
const safe = Number.isSafeInteger;
const alias = safe;
console.log(safe === alias, safe === Number.isSafeInteger, safe === Number.isInteger);
console.log(alias(3), alias("3"), safe.call(null, 4), safe.apply(undefined, [4.5]));
const bound = safe.bind(null);
console.log(bound(5), bound !== safe);
const custom = { isSafeInteger(value: string): boolean { return value === "custom"; } };
console.log(custom.isSafeInteger("custom"), custom.isSafeInteger("1"));
function shadow(Number: {isSafeInteger(value: string): boolean}): boolean { return Number.isSafeInteger("custom"); }
console.log(shadow(custom));
