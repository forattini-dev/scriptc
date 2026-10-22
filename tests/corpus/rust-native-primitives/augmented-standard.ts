/// <reference path="./augmented-standard.d.ts" />
// @rust-only
// @no-engine
function brand(value: unknown): boolean { return Array.isArray(value); }
console.log("augmented arrays", brand([1]), brand([]), brand("text"), brand({ length: 1 }));
const tuple: [number, string] = [2, "value"];
console.log("augmented tuple", Array.isArray(tuple), brand(tuple));
console.log("augmented math", Math.floor(2.9), Math.round(-2.5), Math.min(3, 1));
console.log("augmented string", " text ".trim(), "text".length, "x".repeat(2));
