// @rust-only
// @no-engine
// C/LLVM's current JSON decoder merges lone surrogate keys into U+FFFD.
interface Counters { fixed: number; [key: string]: number }
const counters = JSON.parse('{"fixed":1,"\\ud800":2,"\\udc00":3,"�":4,"extra":5}') as Counters;
console.log("decoded", counters.fixed, JSON.stringify(counters));
console.log("keys", Object.keys(counters).map(key => key.charCodeAt(0)).join(","));
const empty = JSON.parse('{"fixed":7}') as Counters;
console.log("no extras", JSON.stringify(empty));
