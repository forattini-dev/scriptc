// @rust-only
// Schema error classes carrying unknown-typed props: `cause` (Schema.Defect,
// optional or required) is the Error cause, and other unknown props
// (Schema.Unknown, optional Schema.Defect) are ordinary checked-dynamic
// fields. Reads narrow back out through instanceof and typeof checks.
import { Schema } from "effect";

class OperationFailed extends Schema.TaggedErrorClass<OperationFailed>()("OperationFailed", {
  operation: Schema.Literals(["clone", "fetch"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class Wrapped extends Schema.TaggedErrorClass<Wrapped>()("Wrapped", {
  cause: Schema.Defect(),
}) {}

class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()("ToolFailure", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  body: Schema.Unknown,
}) {}

const root = new Error("disk full");
const withCause = new OperationFailed({ operation: "clone", message: "clone failed", cause: root });
const withoutCause = new OperationFailed({ operation: "fetch", message: "fetch failed" });

console.log(withCause.message, withCause.operation, withCause._tag);
console.log(withCause.cause instanceof Error, root.message);
if (withCause.cause instanceof Error) console.log("cause message:", withCause.cause.message);
console.log(withoutCause.cause === undefined, typeof withoutCause.cause);

const wrapped = new Wrapped({ cause: "plain text" });
console.log(typeof wrapped.cause, wrapped.cause === "plain text");

const tool = new ToolFailure({ message: "tool broke", error: 42, body: "payload" });
console.log(tool.message, typeof tool.error, tool.error === 42, typeof tool.body);
const quiet = new ToolFailure({ message: "quiet", body: null });
console.log(quiet.error === undefined, quiet.body === null);

try {
  throw withCause;
} catch (error) {
  if (error instanceof OperationFailed) console.log("caught", error.operation, error.cause instanceof Error);
}
