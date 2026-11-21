import { Counter } from "./counter.js";
const counter = new Counter("one");
function read(key: "~name"): string { return counter[key]; }
console.log(read("~name"));
