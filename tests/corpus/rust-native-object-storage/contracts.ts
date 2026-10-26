// @rust-only
// @no-engine
import {fixed, update, snapshot} from "./public-package/index.js";
const typed: Record<string, number> = {};
typed.count = 7;
update(7);
const view = snapshot();
console.log("contract", fixed.value, view.value, typed.count === 7);
update(9);
console.log("live-view", view.value, fixed.value);
