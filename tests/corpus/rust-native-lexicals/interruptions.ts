// @rust-only
// @no-engine
function fail(): number { throw new Error("rhs"); }
function interrupted(): void {
  let value!: number;
  try { value = fail(); }
  catch (error) { console.log("catch before assignment", String(value), (error as Error).message); }
  finally { console.log("finally before assignment", String(value)); }
  console.log("after failed assignment", String(value));
  value = 6;
  try { value = fail(); }
  catch { console.log("previous value", value + 1); }
  console.log("retained", value + 2);
}
function oneBranch(run: boolean): void {
  let value!: string;
  try { if (run) value = "set"; }
  catch { console.log("unexpected"); }
  console.log("branch", String(value));
}
function finalizerWins(failFirst: boolean): number {
  let value: number;
  try { value = failFirst ? fail() : 1; }
  catch { console.log("caught"); }
  finally { value = 9; }
  return value + 1;
}
function callbackMutation(): void {
  let value: number | undefined;
  const clear = (): void => { value = undefined; };
  value = 5;
  try { clear(); }
  catch { console.log("unexpected mutation"); }
  console.log("cleared", value === undefined);
}
interrupted();
oneBranch(false);
oneBranch(true);
console.log("override", finalizerWins(false), finalizerWins(true));
callbackMutation();
