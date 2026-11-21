import { EqualBox } from "./equal.js";
const box = new EqualBox("receiver");
const brand = box.brand;
console.log("identity", brand === box.brand);
console.log("call", brand.call(box));
