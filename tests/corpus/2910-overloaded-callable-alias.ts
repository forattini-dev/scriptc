// Immutable aliases of overloaded declarations are compile-time callable
// projections. Calls still resolve overloads per site, while value reads
// reuse the declaration's one interned closure (identity and typeof match
// Node without allocating an alias slot).
function pick(kind: "s"): string;
function pick(kind: "n"): number;
function pick(kind: "s" | "n"): string | number {
  return kind === "s" ? "alpha" : 42;
}

const stored = pick;
const chained = stored;
console.log(stored("s").length, stored("n") + 1);
console.log(chained("s"), chained("n"));
console.log(stored === pick, chained === stored, typeof stored);

function nested(): string {
  const local = stored;
  return `${local("s")}:${local("n")}`;
}
console.log(nested());
