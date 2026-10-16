// @rust-only
// @no-engine
// @npm-static: auto
import { multiply, apply, create, describe, maybe, double, wordScale, counter, probe } from "native-contract";
import { existsSync } from "node:fs";
import byDefault from "native-contract/math";
import * as namespace from "native-contract";
console.log("contracts", multiply(6, 7), byDefault(3, 4), namespace.multiply(2, 5), wordScale("separate"));
console.log("callback", apply(10, value => value * 3), double(21));
const result = create("redskilled", 42);
console.log("record", describe(result), result.count, result.metadata === undefined);
function report(value: string | undefined): void {
  console.log("maybe", value === "ready", value === undefined);
}
report(maybe(true));
report(maybe(false));
const next = counter(10);
console.log("js-capture", next(), next());
console.log("runtime-callback", probe("package.json", path => existsSync(path)));
