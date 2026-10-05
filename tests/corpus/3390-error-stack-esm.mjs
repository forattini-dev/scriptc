// @rust-only
// @no-engine
function leaf() {
  const error = new Error("esm");
  Error.captureStackTrace(error);
  return error;
}
const error = leaf();
console.log(error.stack.split("\n")[1]);
console.log(error.stack.split("\n")[2]);
