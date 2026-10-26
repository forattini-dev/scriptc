// @ts-nocheck
// @rust-only
// @no-engine
import "./preload.cjs";
import data from "./asset.json" with {type: "json"};
import again from "./asset.json" with {type: "json"};
console.log("preloaded", data.count, data.nested.label, data === again);
