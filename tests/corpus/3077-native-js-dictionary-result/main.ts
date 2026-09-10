// @no-engine
// @rust-only
import { parse } from "./source.js";

function show<T extends { options: Record<string, unknown> }>(result: T): void {
  for (const key of Object.keys(result.options)) console.log(key, result.options[key]);
}
show(parse(["count", "verbose", "count"]));
show(parse([]));
const result = parse(["first"]);
show(result);
const options: Record<string, unknown> = result.options;
options["second"] = 2;
show(result);
console.log("identity", options === result.options);
