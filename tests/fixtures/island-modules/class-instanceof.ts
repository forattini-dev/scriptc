// @dynamic
// `instanceof` across the boundary: an instance the realm constructed
// answers true against its own class and false against an unrelated one.
// Both operands stay realm values, so the engine's own
// InstanceofOperator is what answers.
import { Counter, Marker } from "classzoo";

const counter = new Counter(1);
console.log(`${counter instanceof Counter}:${counter instanceof Marker}`);
