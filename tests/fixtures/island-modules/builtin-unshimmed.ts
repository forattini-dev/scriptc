// @dynamic
// A require() of a Node builtin the Rust island does not shim: the build
// EMBEDS it, and the throw surfaces at runtime with the island's message.
import { name } from "needsnet";

console.log(name());
