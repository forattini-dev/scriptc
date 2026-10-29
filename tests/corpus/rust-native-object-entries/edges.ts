// @ts-nocheck
let effects = 0;
function extra(): number { effects++; return 3; }
try { Object.entries(null, extra()); }
catch (error) { console.log("null", error instanceof TypeError, effects); }
const chars = Object.entries("ab");
console.log("chars", chars[0][0], chars[0][1], chars[1][0], chars[1][1]);
const sparse: any[] = ["a", "b", "c"];
delete sparse[1];
const pairs = Object.entries(sparse);
console.log("sparse", pairs.length, pairs[0][0], String(pairs[0][1]), pairs[1][0], String(pairs[1][1]));
function ownEntries(value: number): number { return value + 1; }
function shadow(Object: { entries: (value: number) => number }): number { return Object.entries(4); }
console.log("shadow", shadow({ entries: ownEntries }));
