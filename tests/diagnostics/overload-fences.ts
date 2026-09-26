// The overload fences that REMAIN now that overload signatures lower:
// generic overload calls (the per-instantiation body would be typed
// against a signature it was never checked under), and the multi-
// signature type surfacing where a binding needs it spelled.
function twice<T>(x: T): T[];
function twice<T>(x: T, n: number): T[];
function twice<T>(x: T, n?: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < (n ?? 2); i++) out.push(x);
  return out;
}
console.log(twice("q").length);
function pick(x: "a"): string;
function pick(x: "b"): number;
function pick(x: "a" | "b"): string | number {
  return x === "a" ? "alpha" : 42;
}
// An immutable declaration alias now projects onto the implementation;
// calls and non-escaping observations such as typeof compile.
const asValue = pick;
console.log(typeof asValue);
