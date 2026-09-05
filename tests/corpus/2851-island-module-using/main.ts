// @dynamic
// @island-module: ./resources.ts
// Explicit resource management inside an ISLAND module: `using` and
// `await using` disposal order, disposal on throw, and SuppressedError
// wrapping — the embedded source downlevels the declarations to the
// try/finally form, so the engine never runs the syntax itself (boa
// compiles `using` but does not dispose it), and the prelude supplies
// DisposableStack where the engine lacks it.
import { ordered, throwing, stacked, asyncOrdered } from "./resources.ts";

console.log(ordered());
console.log(throwing());
console.log(stacked());
console.log(await asyncOrdered());
