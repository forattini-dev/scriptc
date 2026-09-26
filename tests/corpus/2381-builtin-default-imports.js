// Default imports of supported builtins in JS sources: Node's default
// export of a CJS builtin IS the module object, so the binding exposes
// exactly the namespace-import member surface (the pattern's source tree
// spells nearly every builtin import this way).
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import url from "node:url";
import processModule from "node:process";

console.log(path.join("a", "b", "..", "c"), path.sep, path.basename("/x/y.txt"), path.extname("f.tar.gz"));
console.log(os.EOL === "\n", os.tmpdir().length > 0, os.homedir().length > 0);
console.log(fs.existsSync("/nonexistent-xyz-dir"));
console.log(url.fileURLToPath("file:///tmp/a%20b.txt"), url.pathToFileURL("/tmp/x y").href);
console.log(path.dirname("/home/u/f.txt"), path.isAbsolute("x/y"), path.resolve("/a", "b", "../c"));
console.log(processModule.cwd() === process.cwd(), processModule.platform === process.platform);
