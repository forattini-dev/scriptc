// @no-engine
type Impact = "major" | "minor" | "patch";
const pending = { major: 0, minor: 0, patch: 0 };
function impact(): Impact { return "minor"; }
pending[impact()] += 1;
pending["patch"] += 2;
console.log(JSON.stringify(pending));
let trace = "";
const first = { count: 8 }, other = { count: 100 };
let current = first;
function receiver(): { count: number } { trace += "R"; return current; }
function key(): "count" { trace += "K"; return "count"; }
function rhs(): number { trace += "V"; first.count = 50; current = other; return 3; }
const answer = receiver()[key()] += rhs();
console.log(trace, answer, first.count, other.count);
const dictionary: Record<string, number> = { start: 4 };
dictionary["start"] *= 3;
const missing = dictionary["missing"] += 2;
console.log(dictionary["start"], Number.isNaN(missing), Number.isNaN(dictionary["missing"]));
const words: Record<string, string> = { name: "native" };
console.log(words["name"] += "!", words["absent"] += "?");
const named = { word: "native" };
console.log(named["word"] += 2, named.word);
const numbered: Record<number, number> = { 1: 5 };
console.log(numbered[1] += 3, numbered[1]);
const bits: Record<string, number> = { value: 7 };
bits["value"] <<= 2;
bits["value"] ^= 3;
bits["value"] >>>= 1;
console.log("bits", bits["value"]);
function failure(): number { trace += "X"; throw new Error("rhs"); }
trace = "";
try { receiver()[key()] += failure(); } catch { console.log("throw", trace, other.count); }
