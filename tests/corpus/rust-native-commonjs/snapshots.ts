import leaf, { value as snapshot, change } from "./cjs/leaf.js";
change(11);
console.log("snapshot", snapshot, leaf.value);
