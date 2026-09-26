// @dynamic
// createRequire over INSTALLED packages: the require resolves under
// Node's "require" condition at build time — a CJS package's value IS
// module.exports (the lexed facade's default), a dual package answers
// its CJS arm (where the import condition would load the ESM arm), and
// a bare name nothing installed resolves throws Node's catchable
// MODULE_NOT_FOUND at the call.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// A plain CJS package: module.exports members through the island.
const zoo = require("cjszoo") as any;
console.log("zoo:", zoo.alpha as string, zoo.extra as string, zoo.gamma() as string);
console.log(
  "zoo resolve:",
  (zoo.resolved as string).endsWith("/cjszoo/core.js"),
  (zoo.resolvePaths as string[])[0]?.endsWith("/cjszoo"),
);

// The dual package: "exports" splits import/require — require() loads
// the CJS arm, exactly Node's createRequire.
const dual = require("dual") as any;
console.log("dual:", dual.flavor as string);

// Missing package: catchable MODULE_NOT_FOUND (the optional-dependency
// try/require pattern).
try {
  require("definitely-not-installed-here");
  console.log("SHOULD NOT PRINT");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("missing:", err.code, `${err.message}`.split("\n")[0]);
}
