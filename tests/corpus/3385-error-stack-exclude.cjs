// @rust-only
// @no-engine
function factory() {
  const error = new Error("filtered");
  Error.captureStackTrace(error, factory);
  return error;
}
function outer() { return factory(); }
function absent() {}
const error = outer();
console.log(error.stack.split("\n")[0]);
console.log(error.stack.split("\n")[1]);
Error.captureStackTrace(error, absent);
console.log(error.stack);
