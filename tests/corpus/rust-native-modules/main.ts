// @rust-only
// @no-engine
console.log("entry body");
import { twice as multiply, importedValue } from "./left.ts";
import * as right from "./right.ts";
import defaultName from "./default.ts";
import type { Label } from "./types.ts";
import { type NamedLabel } from "./named-types.ts";
console.log("entry", multiply(21), right.forward(3), importedValue);
const label: Label = defaultName("ok");
console.log(label);
const named: NamedLabel = "named";
console.log(named);
