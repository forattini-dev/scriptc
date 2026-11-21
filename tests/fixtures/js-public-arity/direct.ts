import { Box, unused, usesArguments, first } from "./implementation.js";
let effects = 0;
const box = new Box("receiver");
console.log("method", box.brand(), box.brand((effects++, "value")), effects);
console.log("arguments", box.collect(), box.collect("value"));
console.log("functions", unused(), unused("value"), usesArguments(), usesArguments("value"));
console.log("prefix", box.prefix("a:"), box.prefix("b:", ++effects), first("first"), first("second", ++effects), effects);
const alias = unused;
console.log("alias", alias === unused, alias("value"));
