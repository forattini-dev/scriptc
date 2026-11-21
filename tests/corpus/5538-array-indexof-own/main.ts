export {};
const values: any[] = [1, 2, 1, undefined];
const object = { value: 7 };
values.push(object);
console.log('standard', values.indexOf(1), values.indexOf(1, 1), values.indexOf(1, -2));
console.log('start', values.indexOf(1, -Infinity), values.indexOf(1, Infinity), values.indexOf(2, NaN), values.indexOf(2, 1.9));
console.log('identity', values.indexOf(object), values.indexOf({ value: 7 }), values.indexOf(NaN));
const sparse: any[] = [];
sparse.length = 3;
sparse[1] = undefined;
console.log('holes', sparse.indexOf(undefined), sparse.indexOf(undefined, 2));
const erased: any = values;
console.log('coercion', erased.indexOf(1, '1'), erased.indexOf(1, null), erased.indexOf(2, true));
try { erased.indexOf(1, 1n); } catch (error) { console.log('bigint start', error instanceof TypeError); }
const empty: any = [];
console.log('empty start', empty.indexOf(1, Symbol('unused')));

const custom: any[] = [1, 2];
(custom as any).indexOf = function (this: any, item: any, start: any): any {
  console.log('custom', this === custom, item, start);
  return 'custom result';
};
console.log('result', custom.indexOf(5, 1));
function replace(): number {
  (custom as any).indexOf = function (): number { return 99; };
  return 6;
}
console.log('snapshot', custom.indexOf(replace()));
(custom as any).indexOf = 9;
let effects = 0;
function argument(): number { effects++; return 10; }
try { custom.indexOf(argument()); } catch (error) { console.log('noncallable', error instanceof TypeError, effects); }
