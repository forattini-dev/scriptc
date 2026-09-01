// @dynamic
// `new` on a class an embedded package exports: the island's construct.
// The instance stays in the realm, so reading a field and calling a
// method both cross the same boundary the constructor answered.
import { Counter } from "classzoo";

const counter = new Counter(2);
console.log(`${counter.bump(3)}:${counter.bump(4)}:${counter.value}`);
