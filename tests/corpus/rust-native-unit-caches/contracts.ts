// @rust-only
// @no-engine
import { version, clear, set } from "native-unit-cache";
console.log("first", version());
set("2.0");
console.log("cached", version());
clear();
console.log("cleared", version());
set("");
console.log("empty fallback", version());
set(null);
console.log("null fallback", version());
