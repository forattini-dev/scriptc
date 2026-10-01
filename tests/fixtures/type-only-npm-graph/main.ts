// Differential fixture: backend rust, npmStatic auto, allowEngine false.
import type { Shape } from "types-only-box";
import { type Shape as InlineShape } from "inline-effects";
import { local } from "./barrel.ts";
const value: Shape = { label: "type-only npm stays erased" };
const inline: InlineShape = value;
console.log(inline.label, local);
