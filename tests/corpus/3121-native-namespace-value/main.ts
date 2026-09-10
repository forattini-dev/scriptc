// Accepted counterpart of the former ns-import-object diagnostic fixture.
import * as lib from "./lib.ts";

console.log(lib.one());
const grabbed = lib;
console.log(grabbed.one());
