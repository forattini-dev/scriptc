import { createRequire } from "node:module";

const specifier = process.env.MODULE_NAME ?? "./fallback.mjs";
console.log(import.meta.resolve(specifier));
// createRequire uses the same static-literal boundary.
const require = createRequire(import.meta.url);
console.log(require.resolve(specifier));
console.log(require.resolve("./fallback.mjs", { paths: process.argv }));
// Dynamic requests and dynamic search paths remain explicit refusals.
