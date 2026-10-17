// @rust-only
// @no-engine
const held = { value: 1 };
function evaluated(): { value: number } { console.log('evaluate'); held.value = 2; return held; }
function take(): { value: number } {
  try { return evaluated(); } finally { console.log('pending', held.value); held.value = 3; }
}
console.log('identity', take() === held, held.value === 3);
try { throw held; } catch { held.value = 4; }
console.log('payload released', held.value === 4);
function local(): number {
  let value = 0;
  try { value = 1; throw 'stop'; } catch { value = value + 2; } finally { value = value + 3; }
  return value;
}
console.log('locals', local());
