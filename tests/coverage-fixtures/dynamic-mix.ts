// Mixes every blocker kind the report distinguishes: SC2011 (operations
// on any-typed values past the honest static subset — the binding itself
// compiles now), SC2010 (__island_eval) —
// all of which RUN under --dynamic — and static rejections that no flag
// fixes.
const v: any = 21;
const doubled = v * 2;
const root = Math.sqrt(81);
const up = (19.99).toPrecision(3); // static exact-binary precision formatting
const parsed = Number.parseFloat(v); // checked-dynamic coercion compiles natively
const raw = __island_eval("6 * 7");
const unknownScore: unknown = 81;
const flags = unknownScore == 81; // mixed-kind loose equality keeps the fence (same-kind == lowers)
console.log("done");
