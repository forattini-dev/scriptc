// DEFAULT imports of supported builtins in a TS source, under the
// project's own adopted interop knob (esModuleInterop in this case's
// tsconfig): Node's default export of a CJS builtin IS the module object,
// so the binding exposes exactly the namespace-import surface — the same
// tables `import * as fs` keys (a real CLI spells `import fs from
// 'node:fs'` and `import path from 'path'` throughout). The lowering never
// needed the knob (runtime interop); 2948 pins the knob-free spelling
// this file's tsconfig happens to enable.
import fs from "node:fs";
import path from "path";
import url from "node:url";

console.log(fs.existsSync(process.cwd()) ? "cwd-exists" : "cwd-missing");
console.log(path.join("a", "b"));
console.log(url.fileURLToPath("file:///tmp/x.txt"));
