// @dynamic
// The realm's `globalThis.crypto`. node:crypto's shim captures it ONCE at
// shim-factory time, so the whole randomness surface — randomBytes,
// randomUUID, randomFillSync, randomInt — exists only if the web prelude
// installed this global before the module bootstrap ran. Shape-only: the
// values are random, the lengths and types are not.
import { probeRandom } from "shimuser";

console.log(probeRandom());
