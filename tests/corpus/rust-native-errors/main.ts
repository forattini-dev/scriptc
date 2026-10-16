// @rust-only
// @no-engine
let effects = 0;
function mark(label: string, value: number): number {
  effects = effects + 1;
  console.log("effect", label, effects);
  return value;
}
class OperationError extends Error {
  name = "OperationError";
  code = mark("base field", 10);
  constructor(message: string, code = 20) {
    const prepared = mark("before super", code);
    super(message);
    console.log("base body", this.code, this.message);
    this.code = prepared;
  }
}
class DetailedError extends OperationError {
  detail = mark("derived field", 30);
  constructor(message: string) {
    super(message);
    console.log("derived body", this.code, this.detail);
    this.name = "DetailedError";
  }
}
console.log("defined", effects);
const error = new DetailedError("native");
const base: Error = error;
console.log("error", error.name, error.message, error.code, error.detail, effects);
console.log(base === error, base.toString());
console.log(error instanceof DetailedError, error instanceof OperationError, error instanceof Error, error instanceof SyntaxError);
if (base instanceof DetailedError) console.log("narrowed", base.detail, base.code);
const syntax = new SyntaxError("bad input");
console.log("syntax", syntax.name, syntax.message, syntax.toString(), syntax instanceof Error, syntax instanceof TypeError);
const empty = new Error();
console.log("empty", empty.name, empty.message === "", empty.toString());
empty.name = "";
empty.message = "message only";
console.log(empty.toString());
empty.message = "";
console.log(empty.toString() === "");
class ImplicitError extends OperationError {}
const inherited = new ImplicitError("inherited", 44);
console.log("inherited", inherited.name, inherited.message, inherited.code, inherited instanceof OperationError);
const builtin = new Error("same");
const builtinAlias: Error = builtin;
console.log("builtin identity", builtinAlias === builtin, builtinAlias !== new Error("same"), base !== builtin);
