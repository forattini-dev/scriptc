// @rust-only
// Fixed-level deflateSync compiles on the Rust backend only: its runtime
// reproduces Node's level 0, 6 and 9 streams, while the C and LLVM runtimes
// link the system zlib, whose bytes differ, so those backends refuse the form.
import { deflateSync, inflateSync } from "node:zlib";
const input = Buffer.from("native native native native native native", "utf8");
const stored = deflateSync(input, { level: 0 });
const best = deflateSync(input, { level: 9 });
const defaultLevel = deflateSync(input, { level: -1 });
console.log(stored.toString("hex"));
console.log(best.toString("hex"));
console.log(defaultLevel.toString("hex") === deflateSync(input).toString("hex"));
console.log(inflateSync(best).toString("utf8"));
const data = Buffer.from("before", "utf8");
function level(): 9 { data[0] = 65; return 9; }
console.log(inflateSync(deflateSync(data, { level: level() })).toString("utf8"));
