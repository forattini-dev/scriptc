// Spread fences — what stays out and why: non-identifier object spread
// sources (a conditional spread has no fixed shape), spreads after explicit
// properties (the overwrite direction the desugar doesn't model), and
// spreading anything but a same-element-type (or element-LIFTABLE —
// string[] into (string | number)[] wraps per element now) array. Fixed
// tuple call spreads compile and are covered by the differential corpus.

interface Shape {
  x: number;
  y: number;
}
declare function pick(): Shape;
const cond = true;
const s1: Shape = { ...(cond ? { x: 1, y: 2 } : { x: 3, y: 4 }) };
interface YOnly {
  y: number;
}
const yPart: YOnly = { y: 0 };
const s2: Shape = { x: 5, ...yPart };
// A spread field the target keeps (no later override) must match exactly —
// and the diagnostic shows the SOURCE shape, where the difference lives
// (the literal's own type would already have overrides applied and could
// print identically to the target).
interface OptSrc {
  s?: string;
  n: number;
}
interface ReqDst {
  s: string;
  n: number;
}
const optSrc: OptSrc = { n: 1 };
const reqDst = { ...optSrc } as ReqDst;
console.log(reqDst.n);
