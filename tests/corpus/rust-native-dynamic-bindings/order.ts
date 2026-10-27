// @rust-only
// @no-engine
// @ts-nocheck
export {};
let calls = 0;
const shared: any = { first: 1, second: 2 };
function source(): any { calls += 1; return shared; }
const { first, second, first: again } = source();
console.log("once", calls, Number(first), Number(second), Number(again));
shared.first = 8;
console.log("snapshots", Number(first), Number(again), Number(shared.first));
const {} = source();
console.log("empty-once", calls);
function fails(): any { calls += 1; throw new Error("initializer"); }
try { const { first: unreachable } = fails(); console.log(String(unreachable)); }
catch (error) { console.log("abrupt", calls, String(error.message)); }
