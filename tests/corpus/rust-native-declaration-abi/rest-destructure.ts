import { f } from "rest-destructure";
console.log("value", String(f([1])));
console.log("string", String(f("abc")), "empty", String(f([])));
try { f(null); } catch (error) { console.log("null", error instanceof TypeError); }
