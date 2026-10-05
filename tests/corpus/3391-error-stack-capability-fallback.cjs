// @rust-only
// @no-engine
class CustomError extends Error {
  constructor(message) {
    super(message);
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error(message).stack;
    }
    this.name = this.constructor.name;
  }
}
function make() { return new CustomError("fallback"); }
const error = make();
console.log(error.stack.split("\n")[0]);
console.log(error.stack.split("\n")[1]);
