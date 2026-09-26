// @dynamic
// Dual-published package: the ESM ("import" condition) entry wins, exactly
// like Node resolving an import statement.
import { cjsUrl, flavor, zooUrl } from "dual";

const f: string = flavor;
console.log(f);
console.log(cjsUrl.endsWith("/dual/index.cjs"));
console.log(zooUrl.endsWith("/cjszoo/index.js"));
