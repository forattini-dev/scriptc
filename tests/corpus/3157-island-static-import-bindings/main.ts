// @dynamic
import { maybe, bump } from "binding-probe";
import * as ns from "binding-probe";
console.log(maybe === undefined, ns.maybe === undefined);
console.log(bump(), ns.bump());
const later = await import("binding-probe");
console.log(later.maybe === undefined, later.bump());
