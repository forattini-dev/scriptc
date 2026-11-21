// @rust-only
// @no-engine
import * as counter from "./counter.ts";
import * as barrel from "./barrel.ts";

const pair = [counter, barrel] as const;
console.log("identity", pair[0] === counter, pair[1] === barrel);
console.log("values", pair[0].count, pair[1].current, pair[1].read());
