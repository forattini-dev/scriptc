// @dynamic
// An ES module importing a Node builtin the island does not shim yet: the
// loader synthesizes the `node:` wrapper, and its __scr_require call takes
// the does-not-provide throw at evaluation.
import { name } from "esmevents";

console.log(name());
