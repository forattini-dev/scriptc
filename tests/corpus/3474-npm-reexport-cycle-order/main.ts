// @rust-only
// @no-engine
// @npm-static: auto
// @target node26
import { A } from "cycle-barrel";

console.log(new A().make() instanceof A);
