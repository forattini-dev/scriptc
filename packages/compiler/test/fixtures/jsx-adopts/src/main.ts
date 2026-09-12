import summary, { describe } from "./widget.js";
const items = [{ label: "a", count: 1 }, { label: "b", count: 2 }];
console.log(summary(items));
console.log(describe({ label: "c", count: 3 }));
