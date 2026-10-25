// @rust-only
// @no-engine
let n = 2;
console.log('values', n++, n, ++n, n--, --n, n);
console.log('nested', n++ + ++n, n);
let checks = 0;
let total = 0;
while (checks++ < 4) { if (checks === 2) continue; total = total + checks; }
console.log('loop', checks, total);
function locals(): number {
  let x = 4;
  const f = () => x++;
  console.log('captured', f(), f(), x);
  return ++x;
}
console.log('local', locals());
var hoisted = 2;
console.log('var', hoisted++, ++hoisted, hoisted);
let deferred: number;
// @ts-expect-error: Pin JavaScript's NaN result for an uninitialized numeric cell.
console.log('undefined', deferred++, deferred);
let optional: number | undefined = 5;
function clear(): void { optional = undefined; }
clear();
console.log('changed', optional++, optional);
let negativeZero = -0;
const beforeZero = negativeZero++;
console.log('zero', 1 / beforeZero, negativeZero);
let infinity = 1 / 0;
console.log('infinity', infinity++, --infinity);
let nan = 0 / 0;
console.log('nan', nan++, nan);
let result = 1;
function run(): number { try { return result++; } finally { ++result; } }
console.log('finally', run(), result);
