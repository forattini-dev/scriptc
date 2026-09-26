// The CommonJS namespace and destructured require spellings materialize
// the same exact-arity node:path callable values as ESM imports.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const path = require("node:path") as typeof import("node:path");
const { extname, isAbsolute, normalize } = require("node:path") as typeof import("node:path");

const paths = ["/tmp/a.ts", "relative.js", "/root/readme"];
console.log(paths.map(extname).join("|"));
console.log(paths.filter(isAbsolute).join("|"));
console.log(path.extname === extname, path.normalize === normalize);

const transforms: ((value: string) => string)[] = [path.normalize, path.dirname, extname];
console.log(transforms.map((fn) => fn("a//b/../file.ts")).join("|"));
