// @dynamic
// A static RegExp crossing INTO an EMBEDDED MODULE (the
// z.string().regex(/^a+$/) shape). The frontend rebuilds it as
// `new RegExp(source, flags)`; on the Rust lane that lands as a native
// regex value, so the argument marshal has to hand the realm a real
// engine RegExp built from the same source and flags rather than
// refusing the whole call. A fresh realm object per marshal — identity
// and lastIndex stay host-side (SEMANTICS.md).
import { describeRegExp } from "classzoo";

console.log(describeRegExp(/^a+$/, "aaa"));
console.log(describeRegExp(/b/i, "ABC"));
// A multi-flag literal, so the flag STRING has to survive the crossing
// rather than just the pattern.
console.log(describeRegExp(/z\s/gimsu, "z\t"));
// A regex-typed BINDING, the other spelling the frontend lowers: the
// marshal reads its source and flags without consuming it, so the host
// value still answers for itself afterwards. It is deliberately not
// global — a `g` regex's lastIndex is host state that does NOT cross
// (SEMANTICS.md), so re-testing one here would diverge from Node by
// design rather than pin anything.
const bound = /c\d+/;
console.log(describeRegExp(bound, "c42"));
console.log(`${bound.source}:${bound.flags}:${bound.test("c7")}`);
