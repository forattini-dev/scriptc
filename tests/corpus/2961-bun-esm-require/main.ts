// @dynamic
// @target bun
// @island-module: ./md.ts
// Under the bun target an embedded ES module may call `require`: Bun
// scopes a require into every ES module, and the island binds one to
// the module's own key.
import { run } from "./md.ts";

console.log(run());
