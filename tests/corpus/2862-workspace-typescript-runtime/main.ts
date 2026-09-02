// @dynamic
// pnpm workspace links expose TypeScript runtime source outside node_modules.
// The embedded graph must erase supported types before the JS engine parses it.
import { greet } from "workspace-ts-runtime";

console.log(greet("Ada"));
