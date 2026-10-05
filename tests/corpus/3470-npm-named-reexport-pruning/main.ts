// @rust-only
// @no-engine
// @npm-static: auto
// @target node26
import { greet, shout as yell, chained, VERSION, alpha, gamma, toSlug } from "pure-barrel";
import tag from "pure-barrel";

console.log(greet("scriptc"));
console.log(yell("named re-exports"));
console.log(chained(3));
console.log(VERSION, tag);
console.log(alpha(), gamma(), toSlug("Named Re-exports"));
