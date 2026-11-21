import { EqualBox } from "./equal.js";
const box = new EqualBox("receiver");
const brand = box.brand;
console.log("borrowed", brand.call({ value: "borrowed" } as any));
