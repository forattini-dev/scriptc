// @no-engine
class KnownError extends Error {}
const readName = (error: Error): string => error.constructor.name;
const LaterError = class extends Error {};
console.log(readName(new KnownError("known")));
console.log(readName(new LaterError("later")));
const renamed = new TypeError("builtin");
renamed.name = "not the constructor";
console.log(readName(renamed));
console.log(readName(new RangeError("range")));
console.log(readName(new Error("base")));
