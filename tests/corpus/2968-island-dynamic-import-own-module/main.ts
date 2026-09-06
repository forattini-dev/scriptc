// @dynamic
// @island-module: ./lazy.ts
// A dynamic import() of the program's own module when that module lives
// in the ISLAND tier: the engine loads it on demand (its top level runs
// at the first import, after the importer's synchronous code), and the
// namespace promise answers its exports.
console.log("start");
const first = await import("./lazy.ts");
console.log(first.describe(1));
const second = await import("./lazy.ts");
console.log(second.label, second === first ? "same" : "fresh");
const { describe } = await import("./lazy.ts");
console.log(describe(2));
console.log("end");
