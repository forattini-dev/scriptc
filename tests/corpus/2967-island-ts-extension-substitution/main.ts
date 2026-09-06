// @dynamic
// @target bun
// @island-module: ./hook.ts
// An island module's relative `./runtime.js` resolves to runtime.ts
// (TypeScript's extension substitution), as Bun resolves it at runtime.
import { hook } from "./hook.ts";

console.log(hook("brain"));
