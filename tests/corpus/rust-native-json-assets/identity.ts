// @ts-nocheck
// @rust-only
// @no-engine
import first from "./asset.json" with {type: "json"};
import second from "./asset.json" with {type: "json"};
import required from "./load.cjs";
import {current, mutate} from "./other.ts";
console.log("identity", first === second, first === current(), first === required);
console.log("data", first.name, first.enabled, first.count, first.nested.label);
console.log("members", Array.isArray(first.list), first.list[1] === null, first.empty === null);
mutate();
console.log("live", first.count, second.count, first.nested.label, required.nested.label === "updated");
console.log("keys", Object.keys(first).join(","), Object.hasOwn(first,"__proto__"));
