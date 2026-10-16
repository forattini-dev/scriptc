// @rust-only
// @no-engine
import { left, leftValue } from "./left.ts";
import { rightValue } from "./right.ts";
console.log("cycle", left(3), leftValue, rightValue);
