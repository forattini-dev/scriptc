// @dynamic
// A require() of a Node builtin the island does not shim yet: the build
// EMBEDS it, and the throw surfaces at runtime with the island's message.
import { name } from "needsevents";

console.log(name());
