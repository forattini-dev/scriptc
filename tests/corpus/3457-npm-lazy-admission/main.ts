// @rust-only
// @no-engine
// @npm-static: auto
// @target node26
import { run } from "lazy-outer";
console.log("main");
console.log(await run());
console.log(await run());
