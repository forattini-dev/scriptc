// @rust-only
// @no-engine
import { memo, write } from "./cycle-a.ts";
import { read } from "./cycle-b.ts";
console.log("entry", memo === undefined);
write("live");
read();
