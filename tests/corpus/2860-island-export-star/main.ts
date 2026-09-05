// @dynamic
// @island-module: ./inner.ts
// Names imported from a static barrel that `export *`s an island module
// bind as island handles, exactly as a direct import would.
import { hit, describe, label, own } from "./barrel.ts";

console.log(own, label);
console.log(hit(), hit());
try {
  throw new Error("boom");
} catch (e) {
  console.log(describe(e instanceof Error ? e.message : "?"));
}
console.log(describe(41 + 1));
