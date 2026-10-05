// @rust-only
// @no-engine
// @npm-static: auto
// @target node26
import { read, matches } from "literal-data";
console.log(read());
console.log(matches("alpha"), matches("other"));
console.error("literal data stays native");
