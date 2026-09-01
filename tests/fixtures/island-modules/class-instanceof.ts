// @dynamic
// `instanceof` across the boundary: an instance the realm constructed
// answers true against its own class, an unrelated instance answers
// false, and neither side leaves the realm to be asked.
import { Counter } from "classzoo";

const counter = new Counter(1);
const other = new Error("not a counter");
console.log(`${counter instanceof Counter}:${other instanceof Counter}`);
