// @rust-only
// @no-engine
// @ts-nocheck
// Undefined-capable numeric cells use ToNumeric instead of unchecked narrowing.
var empty: number;
console.log('var', empty++, empty);
const cell: { value: number | undefined } = { value: 7 };
console.log('field', cell.value++, cell.value);
cell.value = undefined;
console.log('field-undefined', ++cell.value, cell.value);
let count: number | undefined = 3;
function reset(): void { count = undefined; }
while (count !== undefined) { console.log('backedge', count--); reset(); }
console.log('backedge-undefined', count++, count);
function local(): void {
  let value: number | undefined = 4;
  const resetLocal = () => { value = undefined; };
  resetLocal();
  console.log('local-undefined', ++value, value);
}
local();
