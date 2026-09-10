// @no-engine
// @rust-only
import { parse } from "./source.js";
const parsed = parse();
const result = { positionals: parsed.rest, nested: parsed.nested };
console.log("forward", result.positionals.join(","), result.nested[0].join(","));
console.log("length", result.positionals.length, result.nested.length, result.nested[0].length);
console.log("element", result.positionals[0]);
console.log("identity", result.positionals === parsed.rest, result.nested === parsed.nested);
const alias = parsed.rest;
const again = { values: alias };
console.log("alias", again.values.join(","), again.values === parsed.rest);
const typed = { positionals: parsed.rest } as { positionals: string[] };
typed.positionals.push("typed");
console.log("write", result.positionals.join(","), again.values.join(","));
function forward() {
  const source = parse();
  const rest = source.rest;
  const wrapped = { rest };
  console.log("local", wrapped.rest.join(","), wrapped.rest === source.rest);
}
forward();
