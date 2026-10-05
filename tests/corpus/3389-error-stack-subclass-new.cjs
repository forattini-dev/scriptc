// @rust-only
// @no-engine
class CustomError extends Error {
  constructor(message) { super(message); }
}
function make() { return new CustomError("created"); }
const error = make();
console.log(error.stack.split("\n")[0]);
console.log(error.stack.split("\n")[1]);
console.log(error.stack.split("\n")[2]);
