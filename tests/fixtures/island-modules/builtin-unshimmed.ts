// @dynamic
// Bundled code may import node:net without using a socket on this command.
// The module must load with Node's shape; unsupported socket calls remain
// loud runtime fences in the island shim.
import { name } from "needsnet";

console.log(name());
