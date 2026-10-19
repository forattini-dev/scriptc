// @rust-only
// @no-engine
import { cache, read, write } from "./cycle-a.js";
console.log("cycle initialized", cache === null, read());
write("live");
console.log("cycle live", cache === "live", !read());
write(null);
console.log("cycle cleared", cache === null);
