import { Box, unused, usesArguments } from "./implementation.js";
let effects = 0;
const box = new Box("receiver");
console.log("method", box.brand(), box.brand((effects++, "value")), effects);
console.log("arguments", box.collect(), box.collect("value"));
console.log("functions", unused(), unused("value"), usesArguments(), usesArguments("value"));
const brand = box.brand;
console.log("identity", brand === box.brand);
console.log("call", brand.call(box, "value"));
