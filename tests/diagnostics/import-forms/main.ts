// The import/export forms that stay OUTSIDE the lowered set now that
// local-module namespace imports, namespace re-exports of user modules,
// default exports/imports, and DEFAULT imports of builtin modules compile
// (Node's CJS-builtin default interop is runtime-native — corpus
// 2948 pins the positive): package/builtin star re-exports, namespace
// imports of JSON and CommonJS modules, and the module namespace OBJECT
// as a first-class value (member accesses resolve statically; the frozen,
// alphabetically-keyed object itself is not materialized).
import * as helpers from "./helpers.ts";
import * as cfg from "./cfg.json";
import * as legacy from "./legacy.cjs";

// NAMED re-exports from supported builtins lower now (the facade idiom);
// the STAR form still has no lowering — no namespace object to rebuild.
export * from "node:child_process";

const grabbed = helpers;
console.log(grabbed.one(), helpers.one(), cfg.count, legacy.two);