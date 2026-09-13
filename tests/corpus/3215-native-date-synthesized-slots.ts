// @rust-only
// @no-engine
// Synthesized Date | undefined slots previously escaped as invalid IR.
function defaultDate(value: Date = new Date(0)): number {
  return value.getTime();
}
console.log(defaultDate(), defaultDate(undefined), defaultDate(new Date(123)));

function* dates(): Generator<Date, void, unknown> {
  yield new Date(0);
}
for (const value of dates()) console.log(value.getTime());
