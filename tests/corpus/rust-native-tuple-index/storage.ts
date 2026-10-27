// @rust-only
// @no-engine
export {};
const pair = ["left", "right"] as const;
function absentIndex(): number { return 8; }
function presentIndex(): number { return 1; }
function observeModule(): void { console.log("module", absent === undefined, present ?? "missing"); }
const absent = pair[absentIndex()];
const present = pair[presentIndex()];
observeModule();
function capture(index: number): () => string | undefined {
  const snapshot = pair[index];
  return () => snapshot;
}
console.log("capture", capture(1)(), capture(9)() === undefined);
let mutable = pair[presentIndex()];
function clear(): void { mutable = pair[absentIndex()]; }
clear();
console.log("mutable", mutable === undefined);
