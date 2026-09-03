// @dynamic
// util.inspect over island-backed `any` scalars preserves Node's primitive
// rendering, including -0 and string quoting. Composite values remain behind
// the explicit unsupported fence until their engine-owned shape can be walked.
import { inspect } from "node:util";

const negativeZero: any = __island_eval("-0");
const text: any = __island_eval("\"it's dynamic\"");
const yes: any = __island_eval("true");
const nil: any = __island_eval("null");
const absent: any = __island_eval("undefined");

console.log(inspect(negativeZero));
console.log(inspect(text));
console.log(inspect(yes));
console.log(inspect(nil));
console.log(inspect(absent));
