// @dynamic
// @rust-only
// @island-module: ./format.ts
// Intl inside the island: the engine carries its own locale data, so
// formatting, plural rules, segmentation, list formatting and collation
// answer as Node does.
import { money, grouped, plural, graphemes, list, sorted } from "./format.ts";

console.log(money(1234.5), grouped(1234567.891));
console.log(plural(1), plural(2), plural(0));
console.log(graphemes("héllo"), graphemes("👩‍👩‍👧"), graphemes("abc"));
console.log(list(["a", "b", "c"]));
console.log(sorted(["b", "a", "ä", "z"]).join(","));
