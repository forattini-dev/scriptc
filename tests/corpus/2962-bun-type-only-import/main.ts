// @dynamic
// @target bun
// @island-module: ./host.ts
// `import { type X } from "./worker.ts"` under the bun target: Bun elides
// an all-type import outright, so the worker script's top level never
// runs in the main thread (Node's type stripping would keep it as a
// side-effect import).
import { describe } from "./host.ts";

console.log(describe());
