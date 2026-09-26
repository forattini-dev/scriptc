// node:module — createRequire's LOWERED shape is a const binding over
// createRequire(import.meta.url) (or __filename) whose require calls
// take STATIC string literals (builtins, compiled project modules,
// relative .json documents, --npm-static packages, and installed npm
// packages under --dynamic). Everything else fences by
// name: a base that is not "this file" keeps the member fence (the
// returned require would resolve from a directory the compiler is not
// standing in), a computed specifier cannot exist in a fixed module
// graph, and an unresolved relative target still fences by name.
import { createRequire } from "node:module";

// The base names some OTHER file: unrecognized — the member fence.
const req = createRequire("/tmp/parent.js");
console.log(String(req("./config.cjs")));
// The supported base still fences dynamic requests and unresolved modules.
const require = createRequire(import.meta.url);

// A computed specifier: fenced by name.
const which = "left" + "-pad";
require(which);

// An unresolved relative target.
require("./helper.js");
