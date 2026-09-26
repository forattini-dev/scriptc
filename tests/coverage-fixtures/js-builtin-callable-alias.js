// JavaScript builtin aliases remain compile-time call targets, not static
// function values. The direct call lowers; the escaping value keeps the
// pre-existing named fence instead of materializing a TypeScript closure.
import { extname } from "node:path";

const ext = extname;
console.log(ext("/tmp/example.ts"));
console.log(ext);
