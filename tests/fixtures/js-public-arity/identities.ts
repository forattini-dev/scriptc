import { EqualBox } from "./equal.js";
const first = new EqualBox("first");
const second = new EqualBox("second");
const method = first.brand;
console.log("identity", method === first.brand, method === second.brand);
console.log("receiver", method.call(first), method.call(second));
