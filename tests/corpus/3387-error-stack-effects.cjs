// @rust-only
// @no-engine
class CustomError extends Error {}
const error = new CustomError("effects");
let calls = 0;
function target() { calls++; return error; }
Error.captureStackTrace(target());
console.log(calls);
console.log(target().stack.split("\n")[0]);
console.log(calls);
