// @rust-only
// @no-engine
const serialize = require("./serializer.cjs");
console.log(serialize(42));
console.log(serialize("tail"));
console.log(typeof serialize);
