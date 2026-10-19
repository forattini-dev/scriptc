// @rust-only
// @no-engine
import * as a from "./cycle-a.ts";
import * as b from "./cycle-b.ts";
const first = a;
const second = b;
console.log("cycle", first.other === b, second.other === a, first.other.other === a);
a.update(11);
console.log("live cycle", first.other.value, second.value);
