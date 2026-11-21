// @rust-only
// @no-engine
// @transform-types
class Fault extends Error { static effect = console.log("error static"); }
class Box { static value = console.log("ordinary static"); }
new Box();
function effect(): number { console.log("initializer"); while (true) { return 1; } }
const unused = effect();
class ErrorWithConstructor extends Error {
  constructor() { super(); console.log("constructor"); while (false) {} }
}
new ErrorWithConstructor();
class ParameterFault extends Error { constructor(public code: number) { super(); } }
console.log("parameter property", new ParameterFault(7).code);
