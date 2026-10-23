// @rust-only
// @no-engine
function source(fail: boolean): number {
  if (fail) throw new Error("source");
  return 7;
}
function returningCatch(fail: boolean): number {
  let size: number;
  try { size = source(fail); }
  catch { return -1; }
  return size + 1;
}
function throwingCatch(fail: boolean): number {
  let size: number;
  try { size = source(fail); }
  catch (error) { throw error; }
  return size + 2;
}
function bothAssign(fail: boolean): number {
  let size: number;
  try { size = source(fail); }
  catch { size = 20; }
  return size + 3;
}
function tryReturns(fail: boolean): number {
  let size: number;
  try { return source(fail); }
  catch { size = 30; }
  return size + 4;
}
function noCatch(): number {
  let size!: number;
  try { size = 40; } finally { console.log("finally assigned", String(size)); }
  // A presence guard proves the projection even at a conservative finalizer join.
  if (size !== undefined) return size + 5;
  return -2;
}
console.log("returning", returningCatch(false), returningCatch(true));
console.log("throwing", throwingCatch(false));
try { throwingCatch(true); }
catch (error) { console.log("thrown", (error as Error).message); }
console.log("both", bothAssign(false), bothAssign(true));
console.log("try returns", tryReturns(false), tryReturns(true));
console.log("finally", noCatch());
