import { ParseError, InvalidError } from "./errors.js";
const details: Record<string, unknown> = { text: "kept", count: 2, items: ["a", 3], inner: { nested: true } };
const error = new ParseError("bad input", "INVALID", details);
console.log("error", error.name, error.message, error.code);
console.log(error instanceof ParseError, error instanceof Error, error.details === details);
if (error.details !== undefined) {
  console.log(error.details.text === "kept", error.details.count === 2, (error.details.items as any).length === 2);
}
const absent = new ParseError("empty", "EMPTY");
console.log(absent.details === undefined, absent.message);
const subclass = new InvalidError("bad");
console.log(subclass instanceof ParseError, subclass instanceof InvalidError, subclass.name, subclass.value, subclass.message);
