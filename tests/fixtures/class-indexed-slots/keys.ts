import { Counter } from "./counter.js";
const counter = new Counter("one");
console.log("values", counter["~count"], counter["~name"]);
console.log("keys", Object.keys(counter as any).join(","));
delete (counter as any)["~name"];
(counter as any)["~name"] = "three";
console.log("reinsert", Object.keys(counter as any).join(","), counter["~name"]);
