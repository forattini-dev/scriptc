// @ts-nocheck
// @rust-only
// @no-engine
try { Number.parseInt(Symbol("text"), 16); }
catch (error) { console.log("int symbol", error instanceof TypeError, String(error.message)); }
try { Number.parseFloat(Symbol("text")); }
catch (error) { console.log("float symbol", error instanceof TypeError, String(error.message)); }
try { parseInt("11", Symbol("radix")); }
catch (error) { console.log("symbol radix", error instanceof TypeError, String(error.message)); }
try { parseInt("11", 2n); }
catch (error) { console.log("bigint radix", error instanceof TypeError, String(error.message)); }
console.log("bigint text", parseInt(12345678901234567890n), parseFloat(12345678901234567890n));
console.log("float ignores radix", parseFloat("2.5", Symbol("ignored"), 2n));
