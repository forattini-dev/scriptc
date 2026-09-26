import { stable, readStable, mutable, readMutable, escaped, readEscaped } from "./tables.ts";

console.log("imported", stable[1] * 2, readStable(2), readStable(0.5));
console.log("before", readMutable(0));
mutable[0] = 23;
console.log("after", readMutable(0));
const alias = escaped;
alias[1] = 29;
console.log("alias", readEscaped(1));
