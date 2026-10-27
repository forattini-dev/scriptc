// @rust-only
// @no-engine
let checks = 0;
let arms = 0;
function condition(value: unknown): unknown { checks = checks + 1; console.log("condition", checks); return value; }
function arm(value: string): string { arms = arms + 1; console.log("arm", value); return value; }
function fail(): string { console.log("throw"); throw new Error("chosen"); }
console.log("zero", condition(0) ? arm("wrong") : arm("right"));
console.log("object", condition({value: 1}) ? arm("object") : arm("wrong"));
console.log("nested", condition(1) ? (condition("") ? arm("wrong") : arm("nested")) : arm("wrong"));
try { console.log(condition(true) ? fail() : arm("wrong")); }
catch (error) { console.log("caught", error instanceof Error); }
const object = {
  valueOf() { console.log("unexpected valueOf"); return 0; },
  toString() { console.log("unexpected toString"); return ""; },
};
console.log("object coercion", object ? arm("no conversion") : arm("wrong"));
console.log("counts", checks, arms);
