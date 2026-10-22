// @ts-nocheck
// @rust-only
// @no-engine
console.log("repeat", "ab".repeat(3), "é😀".repeat(2.9), "x".repeat(-0.5), "x".repeat(0 / 0));
console.log("units", "😀".length, "😀".repeat(3).length, "e\u0301".length);
console.log("empty", "".repeat(9007199254740992).length, "".repeat(536870889).length, "".repeat(1e300).length);
function count(value: number | undefined): string { return "x".repeat(value); }
console.log("optional", count(undefined), count(2));
