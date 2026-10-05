import { EventEmitter } from "node:events";

class Emitter extends EventEmitter {}
const registry = { Emitter };
console.log(registry.Emitter.name);
