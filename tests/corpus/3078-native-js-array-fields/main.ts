// @no-engine
// @rust-only
import { parse, append } from "./source.js";

interface Result { errors: string[]; rest: string[]; options: Record<string, unknown>; nested: string[][] }
const parsed: Result = parse(["first", "!bad", "last"]);
const errors = parsed.errors;
const nested = parsed.nested;
console.log(errors.join(","), parsed.rest.join(","), parsed.options["count"]);
console.log("identity", errors === parsed.errors, nested === parsed.nested, nested[0] === parsed.nested[0]);
append(parsed, "late");
console.log("late", errors.join(","));
errors.push("typed");
console.log("typed", parsed.errors.join(","));
parsed.errors = ["replacement"];
console.log("replace", parsed.errors.join(","), errors.join(","));
append(parsed, "next");
console.log("current", parsed.errors.join(","));
nested[0].push("typed-inner");
console.log("nested", parsed.nested[0].join(","));
const options = parsed.options;
options["added"] = true;
console.log("options", options === parsed.options, parsed.options["added"]);

function show<T extends { errors: string[]; rest: string[] }>(result: T): void {
  console.log("generic", result.errors.length, result.rest.length);
}
show(parse(["!one"]));
show(parse([]));

const opaque: unknown = parsed;
const checked = opaque as Result;
console.log("checked", checked.errors === parsed.errors, checked.options === options, checked.nested === nested);
checked.errors.push("cast");
console.log("cast-mutation", parsed.errors.join(","));

const metadata: unknown = "tag";
const original = { values: ["a"], metadata };
const boxed: unknown = original;
const mixed = boxed as { values: string[]; metadata: unknown };
console.log("mixed", mixed.values === original.values, mixed.metadata);
mixed.values.push("b");
console.log("mixed-mutation", original.values.join(","));
