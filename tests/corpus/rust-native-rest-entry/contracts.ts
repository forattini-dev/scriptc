// @rust-only
// @no-engine
// @npm-static: auto
import { slots, defaults, empty, ordinary, JSONStringify, JSONParse, annotated, reset, trace, named } from "native-rest-entry";
console.log("missing", slots() === undefined);
console.log("one", slots(null) === undefined);
console.log("two", slots(undefined, null) === undefined);
console.log("three", String(slots(1, "two", 3)));
console.log("extra", slots(1, 2, null, "ignored") === null);
console.log("zero-formals", String(empty(1, 2)));
reset(); defaults(); console.log("trace", trace());
reset(); defaults(null, undefined, 0); console.log("trace", trace());
reset(); defaults("x"); console.log("trace", trace());
reset(); defaults(undefined, "y", undefined); console.log("trace", trace());
console.log("annotation", annotated() === true, annotated("present") === false);
const alias = ordinary;
console.log("alias", alias === ordinary, String(alias("value")));
const object = { answer: 42 };
console.log("json", String(JSONStringify(object, null, 2)));
console.log("json-empty", JSONStringify(undefined) === undefined);
console.log("parse", String(JSONParse("42")));
console.log("named", named(), named(null, "value", 4));
const namedAlias = named;
console.log("named-alias", namedAlias("alias"));
const jsonAlias = JSONStringify;
const jsonResult = jsonAlias(undefined);
console.log("json-alias", jsonResult === undefined);
console.log("receiver-call", ordinary.call({ value: 1 }, "call", null) === "call");
