// @rust-only
// @no-engine
import { report, logger } from "./bridge.js";
report(console.log, "declaration callback");
report(console.warn, "declaration warning");
logger("exported logger");
console.log("public identity", logger === console.error);
