// @rust-only
// @no-engine
/// <reference lib="dom" />
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
console.log("capture presence", "captureStackTrace" in Error);
const dynamicUndefined: any = undefined;
const dynamicNumber: any = 17;
console.log("dynamic message", new Error(dynamicUndefined).message === "", new Error(dynamicNumber).message);
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
const reference = new ReferenceError("missing binding");
const evaluation = new EvalError("bad evaluation");
const uri = new URIError("bad uri");
console.log(
  "other builtins",
  reference.name,
  reference.message,
  reference instanceof Error,
  evaluation.name,
  evaluation instanceof Error,
  uri.name,
  uri instanceof Error,
);
const timeout = new DOMException("deadline", "TimeoutError");
const defaultDom = new DOMException();
console.log(
  "dom exception",
  timeout.name,
  timeout.message,
  timeout.code,
  timeout.toString(),
  timeout instanceof DOMException,
  timeout instanceof Error,
  defaultDom.name,
  defaultDom.message === "",
  defaultDom.code,
);
const aggregateInput: unknown[] = [new Error("first"), 17];
const aggregate = new AggregateError(aggregateInput, "many");
aggregateInput.push("late");
console.log(
  "aggregate error",
  aggregate.name,
  aggregate.message,
  aggregate.errors.length,
  String(aggregate.errors[1]),
  aggregate.toString(),
  aggregate instanceof AggregateError,
  aggregate instanceof Error,
);
