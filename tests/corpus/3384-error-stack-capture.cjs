// @rust-only
// @no-engine
function leaf() {
  const error = new Error("before");
  const result = Error.captureStackTrace(error);
  error.name = "Changed";
  error.message = "after";
  const stack = error.stack;
  console.log(result, stack.split("\n")[0]);
  console.log(stack.split("\n")[1]);
  error.name = "Later";
  console.log(error.stack === stack);
}
leaf();
