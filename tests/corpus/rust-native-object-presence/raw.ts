// @ts-nocheck
// @rust-only
// @no-engine
const raw = JSON.rawJSON("42");
console.log("null-prototype", "rawJSON" in raw, "constructor" in raw, "toString" in raw, "__proto__" in raw, "toJSON" in raw);
console.log("raw-symbol", Symbol.toStringTag in raw, Symbol.iterator in raw);
