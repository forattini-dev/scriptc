// @rust-only
// @no-engine
export {};
const units = ["B", "K", "M", "G", "T"] as const;
function show(index: number): void {
  const value = units[index];
  console.log("unit", index, value === undefined, value ?? "absent");
}
show(0); show(-0); show(4); show(5); show(-1); show(1.5);
show(Number.NaN); show(Number.POSITIVE_INFINITY); show(Number.NEGATIVE_INFINITY);
const mixed: [number, string, boolean, bigint] = [7, "text", false, 12n];
function showMixed(index: number): void { console.log("mixed", mixed[index]); }
showMixed(0); showMixed(1); showMixed(2); showMixed(3); showMixed(9);
function last(): number { return 3; }
console.log("template", `size:${units[last()]}`);
