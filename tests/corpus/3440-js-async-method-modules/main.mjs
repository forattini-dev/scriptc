import { Resource } from "./resource.mjs";
import { Child } from "./child.mjs";

const first = new Child();
const second = new Resource();
const pending = first.destroy();
console.log("before", first.closed, first.calls, second.closed);
await pending;
console.log("after", first.closed, first.calls, second.closed);
