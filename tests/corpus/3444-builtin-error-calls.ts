// @no-engine
function show(error: Error): void {
  console.log(error.name, error.message, error instanceof Error);
}
show(Error("plain"));
show(TypeError("type"));
show(RangeError("range"));
show(SyntaxError("syntax"));
console.log(Error().message === "", TypeError(undefined).message === "");
console.log(TypeError("a") instanceof TypeError, RangeError("b") instanceof RangeError);
console.log(SyntaxError("c") instanceof SyntaxError, Error("a") !== Error("a"));
try { throw TypeError("caught"); }
catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
export {};
