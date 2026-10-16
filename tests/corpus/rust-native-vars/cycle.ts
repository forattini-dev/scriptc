// @rust-only
// @no-engine
import { initial, after } from "./dependency.ts";
export var value: number | undefined = 11;
console.log("cycle", initial, after() === 11);
export function read(): number | undefined { return value; }
