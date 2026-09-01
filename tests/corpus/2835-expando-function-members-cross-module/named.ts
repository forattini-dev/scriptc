// A NAMED export carrying its own members — per-symbol slots, so nothing
// collides with status.ts's identically-spelled member names.
export function named(n: number): number {
  return n * named.factor;
}

named.factor = 7;
named.tag = "named";
named.pairs = { a: 1, b: 2 };
