// @dynamic
// The island's randomness surface, differentially against Node and on
// EVERY island lane: node:crypto's shim reads globalThis.crypto once at
// shim-factory time, so randomBytes/randomUUID/randomFillSync/randomInt
// all cease to exist if the realm's web prelude never installed that
// global. Shape-only — randomzoo runs the surface inside the engine.
import { report } from "randomzoo";

console.log(report());
