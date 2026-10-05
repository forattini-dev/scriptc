import { Base, configured, events } from "./factory.mjs";
const config = { label: "first" };
class First extends configured(config) {}
class Second extends configured({ label: "second" }) {}
const first = new First(7);
console.log(first.describe(), new Second(9).describe());
config.label = "changed";
console.log(First.label(), first.describe());
console.log(first instanceof First, first instanceof Second, first instanceof Base);
console.log(events.join(","));
