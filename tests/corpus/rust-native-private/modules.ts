// @rust-only
// @no-engine
import { Box, make } from "./dependency.ts";
class WeakMap { value = 9; }
const Local = class Local { #value = 7; read(): number { return this.#value; } };
const alias = Box;
console.log("modules", make(3).read(), new alias(5).read(), new Local().read(), new WeakMap().value);
