// @rust-only
// @no-engine
const member = require("./member.cjs");
const nested = require("./nested.cjs");
const whole = require("./whole.cjs");
console.log(member.answer(42));
console.log(nested.answer("tail"));
console.log(whole("done"));
console.log(typeof member.answer, typeof nested.answer, typeof whole);
