// @rust-only
// @no-engine
import { output, standardLog } from "./ambient.ts";
const console = { log: (message: string): void => output("shadow: " + message) };
const alias = console.log;
alias("own receiver");
output(alias === standardLog ? "wrong identity" : "distinct shadow");
