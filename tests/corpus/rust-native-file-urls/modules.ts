// @rust-only
// @no-engine
import { fileURLToPath } from "node:url";
import path from "node:path";
import { moduleUrl, filename, directory, captured } from "./sub dir/dependency.ts";
console.log("module identity", moduleUrl !== import.meta.url, moduleUrl === captured()());
console.log("module path", fileURLToPath(moduleUrl) === filename(""), path.dirname(filename("")) === directory());
console.log("argument", filename(".suffix") === fileURLToPath(moduleUrl) + ".suffix");
console.log("dependency", moduleUrl, filename(""), directory());
