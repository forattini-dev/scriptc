// @dynamic
// A package whose modules `require()` relative .json documents — statuses'
// codes.json and mime-db's db.json in miniature. The documents are DATA
// known at build time: the binding bakes into a comptime global keyed by
// the document, so the two files requiring meta.json share one value
// exactly as Node's module cache does.
import { describe, flag, summary, twinTag } from "jsonzoo";

console.log(summary());
console.log(flag());
console.log(twinTag());
console.log(describe(0));
console.log(describe(2));
