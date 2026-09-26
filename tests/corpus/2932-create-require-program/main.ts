import { createRequire, isBuiltin, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const local = require("./local.cjs");

console.log("local:", local.add(19, 23), local.label);

const projectAlias = require("#local");
console.log("alias:", projectAlias.add(2, 3), projectAlias.label);

const { add: plus, label } = require("./local.cjs") as { add(a: number, b: number): number; label: string };
console.log("destructure:", plus(7, 8), label);

const decorate = require("./factory.cjs") as (value: string) => string;
console.log("factory:", decorate("static"));

require("./side.cjs");
require("./side.cjs");

console.log(
  "builtins:",
  isBuiltin("fs"),
  isBuiltin("node:fs"),
  isBuiltin("test"),
  isBuiltin("node:test"),
  isBuiltin("node:nope"),
);

function checkBuiltin(name: string): boolean {
  return isBuiltin(name);
}

const runtimeName = process.argv.length > 2 ? process.argv[2]! : "node:fs";
console.log("runtime builtin:", checkBuiltin(runtimeName));

syncBuiltinESMExports();
console.log("sync: undefined");
