import { make } from "./bridge.js";
const a = make("repo");
const b = make("repo", "tool");
console.log("contract", a.kind, a.repo, Object.hasOwn(a, "bin"), Object.hasOwn(b, "bin"));
const keys = Object.keys(b);
console.log(keys.length, keys[0], keys[1], keys[2], b.bin === "tool");
