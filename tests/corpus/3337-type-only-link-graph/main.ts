// @rust-only
// @no-engine
import { type Shape } from "./library.ts";
import { local } from "./barrel.ts";
const value: Shape = { label: "inline retains module effects" };
console.log(value.label, local);
