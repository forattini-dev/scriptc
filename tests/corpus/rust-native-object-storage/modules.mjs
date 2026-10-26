// @ts-nocheck
// @rust-only
// @no-engine
import {shared, alias, install, clear} from "./module.mjs";
install();
console.log("imports", shared === alias, alias.value.count === 3);
shared.value.count = 4;
clear();
console.log("snapshot", shared === undefined, alias.value.count === 4);
