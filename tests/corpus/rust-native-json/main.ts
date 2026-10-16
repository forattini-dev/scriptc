// @rust-only
// @no-engine
import config from "./config.json" with { type: "json" };
const VERSION: string = config.version;
console.log("json", VERSION, config.enabled, config.limits.workers, config.rounded);
