// @no-engine
class DisplayError extends Error {
  toString() { return "dynamic prototype"; }
}
function render(value) { return value.toString(); }
console.log(render(new DisplayError("ignored")));
console.log(render(new Error("plain")));
console.log(render(12));
