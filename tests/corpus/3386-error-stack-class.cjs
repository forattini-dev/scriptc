// @rust-only
// @no-engine
class BaseError extends Error {
  constructor(message) {
    super(message);
    if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
  }
}
class LeafError extends BaseError {
  constructor(message) { super(message); }
}
function build() { return new LeafError("class"); }
const error = build();
console.log(error.name, error.stack.split("\n")[0]);
console.log(error.stack.split("\n")[1]);
console.log(error.stack.includes("BaseError"), error.stack.includes("new LeafError"));
