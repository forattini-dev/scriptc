// @dynamic
// @island-module: ./flag.ts
// The static frontier, explicit form: ./flag.ts is a program module the
// Rust lane classifies ISLAND (--island-module), so it embeds as engine
// source and its exports bind here as engine handles — a named import, a
// namespace import, a call returning a primitive (validated on exit), a
// mutable export read through the namespace, and a record result. Under
// Node (and the lanes without the directive) flag.ts is an ordinary
// module, so the output is the same either way.
import { FLAGS, bump, describe, isEnabled } from "./flag.ts";
import * as Flag from "./flag.ts";

console.log(isEnabled("beta"), isEnabled("nope"));
console.log(bump(), bump(), Flag.bump());
console.log(FLAGS.length, FLAGS.join(","));
const d = describe("beta");
console.log(d.name, d.enabled, d.rank);
console.log(Flag.isEnabled("gamma"));
