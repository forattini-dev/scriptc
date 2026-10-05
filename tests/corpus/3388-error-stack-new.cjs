// @rust-only
// @no-engine
function make() {
  return new Error("created");
}
const error = make();
error.message = "changed";
console.log(error.stack.split("\n")[0]);
console.log(error.stack.split("\n")[1]);
console.log(error.stack.split("\n")[2]);
