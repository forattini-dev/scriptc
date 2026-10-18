import { make, gather, record } from "./bridge.js";
const callback = make("contract");
console.log("callback", callback(), callback("a", "b"));
console.log(gather().length, gather("x", "y").join("|"));
const value = record("record", "one", "two");
console.log("contract", value.prefix, value.parts.join("|"));
