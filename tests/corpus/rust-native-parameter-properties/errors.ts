// @rust-only
// @no-engine
// @transform-types
type Code = "MISSING" | "INVALID";
class TokenError extends Error {
  override readonly name = "TokenError";
  constructor(readonly code: Code, readonly token: string, message: string) {
    super(message);
    console.log("error body", this.code, this.token, this.message);
  }
}
function create(ctor: typeof TokenError): TokenError { return new ctor("MISSING", "color", "not found"); }
const constructors = { Error: TokenError };
const error = create(constructors.Error);
console.log("error", error.name, error.code, error.token, error.message, error instanceof Error);
function fail(label: string): number { console.log("throw", label); throw new Error(label); }
function mark(label: string): number { console.log(label); return 1; }
class Explodes {
  field = mark("base field");
  constructor(public value = fail("default")) { console.log("unreached base body"); }
}
class Derived extends Explodes {
  field2 = mark("unreached derived field");
  constructor(public extra = 2) { super(); console.log("unreached derived body"); }
}
try { new Derived(); } catch (error) {
  if (error instanceof Error) console.log("caught", error.message);
  else throw error;
}
const instance = new constructors.Error("INVALID", "size", "bad size");
console.log("alias", instance.code, instance.token, instance instanceof TokenError);
