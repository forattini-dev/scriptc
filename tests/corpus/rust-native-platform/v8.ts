// @rust-only
// @no-engine
import { getHeapStatistics } from "node:v8";

console.log(getHeapStatistics().heap_size_limit > 0);
