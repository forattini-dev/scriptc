import { make, copy } from "./bridge.js";
const source = make();
const result = copy(source);
console.log("case", result !== source, result.values === source.values, result.label, Object.hasOwn(result, "group"));
const present = copy(make("group"));
console.log("case", present.group === "group", Object.keys(present).join("|"));
result.values.push("b");
console.log("case", source.values.join("|"));
