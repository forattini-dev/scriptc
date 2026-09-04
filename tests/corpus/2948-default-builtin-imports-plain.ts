// DEFAULT imports of supported builtins in a plain TS source — NO tsconfig,
// no interop knobs: Node's default export of a CJS builtin IS the module
// object (runtime interop, no flag involved), and the 7-world checker
// answers the same spelling without esModuleInterop. The binding exposes
// exactly the namespace-import surface — the same tables `import * as fs`
// keys — so a real CLI's spelling (`import path from 'path'`) works.
// canonicalBuiltinModule encodes Node's own spelling rules: prefix-only
// builtins (node:test) refuse the bare form. Node is the oracle.
import path from "path";
import os from "node:os";
import fs from "fs/promises";
import url from "url";

console.log(path.sep === "/", path.join("a", "b"), path.basename("/x/y.txt"));
console.log(os.EOL.length >= 1, os.homedir().length > 0);
console.log(url.pathToFileURL("/a b").href.startsWith("file://"), url.fileURLToPath("file:///tmp/x.txt"));

// The namespace surface and the default binding answer the same tables:
// the namespace import's members ARE the default binding's members.
import * as pathNs from "path";
console.log(path.join("a", "b") === pathNs.join("a", "b"), path.sep === pathNs.sep);

// The callable module objects stay callable through the default binding.
import assert from "node:assert";
assert.strictEqual(1 + 1, 2);
assert.ok(true);
console.log("assert default binding callable");