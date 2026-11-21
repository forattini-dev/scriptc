export {};
const values: any[] = [1, 2];
(values as any).unshift = function (this: any, value: number) {
  console.log('custom', this === values, value);
  return 'override';
};
console.log('result', values?.unshift(5), 'length', values.length, 'first', values[0]);
function replace(): number {
  (values as any).unshift = function () { return 99; };
  return 6;
}
console.log('snapshot', values?.unshift(replace()), 'length', values.length);
const spread: any[] = [1, 2];
function replaceDuringSpread(): number[] {
  (spread as any).unshift = function () { return 77; };
  return [7, 8];
}
console.log('spread', spread?.unshift(...replaceDuringSpread()), spread.join(','));
(values as any).unshift = 9;
let effects = 0;
function argument(): number { effects++; return 10; }
try { values?.unshift(argument()); } catch (error) { console.log('noncallable', error instanceof TypeError, effects); }
const pushed: any[] = [];
(pushed as any).push = function (this: any, item: number) {
  console.log('custom push', this === pushed, item);
  return 88;
};
console.log('push result', pushed?.push(11), 'length', pushed.length);
