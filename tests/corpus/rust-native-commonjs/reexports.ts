// @rust-only
// @no-engine
import { add, label, plus } from "./forward-barrel.ts";

console.log(label, add(2, 3), plus(4, 5), add === plus);
