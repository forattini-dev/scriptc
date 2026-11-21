// @ts-nocheck
function process(n: number): number { return n + 1; }
const alias = process;
const decorated = Object.assign(process, { label: "one" });
console.log("identity", alias === decorated, process === decorated, decorated(2));
console.log("properties", alias.label as string, decorated.label as string);
Object.assign(alias, { label: "two" });
console.log("mutation", decorated.label as string, process.label as string);

const arrow = (n: number) => n * 2;
const earlier = arrow;
const wrapped = Object.assign(arrow, { label: "arrow" });
console.log("arrow", earlier === wrapped, wrapped(3), earlier.label as string);

let effects = "";
function one(): string { effects += "1"; return "first"; }
function two(): string { effects += "2"; return "second"; }
Object.assign(earlier, { first: one(), second: two() });
console.log("order", effects, wrapped.first as string, wrapped.second as string);
const sub = (n: number) => n - 1;
Object.assign(earlier, { iterator: sub });
console.log("method", (wrapped.iterator as (n: number) => number)(8));
