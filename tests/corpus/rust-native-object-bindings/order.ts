// @rust-only
// @no-engine
export {};
let calls = 0;
function source(): {left: number; right: number} {
  calls++;
  console.log("source", calls);
  return {left: calls, right: calls + 10};
}
function check(): void {
  const {left, right: alias} = source();
  console.log("values", left, alias, calls);
  const {left: next} = source(), after = calls;
  console.log("next", next, after);
  const {} = source();
  console.log("empty", calls);
}
check();
