// @rust-only
// @no-engine
import { read, bump } from "./cycle-dependency.ts";
export let value = 10;
export function update(): void { value = value + 1; }
console.log(read());
bump();
console.log(read(), value);
