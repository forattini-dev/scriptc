// @rust-only
// @no-engine
// @ts-nocheck
let optional: number | undefined = 4;
function clear(): void { optional = undefined; }
clear();
console.log('live', optional < 5, optional <= 5, optional > 5, optional >= 5);
console.log('assertion', (optional as number) < 5);
let cycles = 0;
optional = 2;
while (optional < 3) { cycles++; clear(); }
console.log('backedge', cycles, optional);
function mixed(a: string | number, b: string | number): void { console.log(a < b, a <= b, a > b, a >= b); }
mixed('10', '2'); mixed(10, '2'); mixed('10', 2);
function caught(): void { try { throw '10'; } catch (e) { console.log('caught', e < 2, e > '2'); } }
caught();

function local(): void {
  let value: number | undefined = 2;
  const reset = () => { value = undefined; };
  reset();
  console.log('local-live', value < 3, value);
}
local();
const box: { value: number | undefined } = { value: 2 };
function clearBox(): void { box.value = undefined; }
if (box.value !== undefined) {
  clearBox();
  console.log('field-live', box.value < 3, box.value <= 3);
}
