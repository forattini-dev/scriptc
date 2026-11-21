import { Base } from "./methods.js";
const events: string[] = [];
const instance = new Base("value:");
function receiver(): Base { events.push("receiver"); return instance; }
function argument(): string { events.push("argument"); return "x"; }
console.log("result", receiver()["~validate"](argument()), events.join(","));
