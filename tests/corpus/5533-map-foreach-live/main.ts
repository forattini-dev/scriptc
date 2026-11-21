export {};
const map = new Map<string, number>([['a', 1], ['b', 2]]);
const receiver = { tag: 'context' };
const seen: string[] = [];
map.forEach(function (this: { tag: string }, value, key, current) {
  seen.push(`${this.tag}:${key}:${value}:${current === map}`);
  if (key === 'a') {
    map.delete('b');
    map.set('c', 3);
    map.set('a', 9);
  }
}, receiver);
console.log('live', seen.join(','), map.get('a'), map.has('b'), map.get('c'));

const cleared = new Map<string, number>([['a', 1], ['b', 2]]);
const clearSeen: string[] = [];
cleared.forEach((value, key) => {
  clearSeen.push(`${key}:${value}`);
  if (key === 'a') { cleared.clear(); cleared.set('z', 7); }
});
console.log('clear', clearSeen.join(','), cleared.size);

const repeated = new Map<string, number>([['x', 1], ['y', 2]]);
const repeatSeen: string[] = [];
repeated.forEach((value, key) => {
  repeatSeen.push(`${key}:${value}`);
  if (key === 'x' && value === 1) { repeated.delete('x'); repeated.set('x', 3); }
});
console.log('reinsert', repeatSeen.join(','));

const nested = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]]);
const nestedSeen: string[] = [];
nested.forEach((_value, key) => {
  nestedSeen.push(`outer:${key}`);
  if (key === 'a') {
    nested.forEach((_innerValue, innerKey) => {
      nestedSeen.push(`inner:${innerKey}`);
      if (innerKey === 'a') nested.delete('a');
    });
  }
});
console.log('nested', nestedSeen.join(','));

const abrupt = new Map<string, number>([['a', 1], ['b', 2]]);
try {
  abrupt.forEach((_value, key) => { if (key === 'a') throw new Error('stop'); });
} catch (error) {
  console.log('throw', error instanceof Error);
}
abrupt.delete('a');
const after: string[] = [];
abrupt.forEach((_value, key) => after.push(key));
console.log('after', after.join(','));

const dynamic = new Map<any, any>();
dynamic.set('x', 2);
dynamic.set(4, 'four');
dynamic.set(Symbol('s'), 99);
const dynamicSeen: string[] = [];
dynamic.forEach((value, key, current) => {
  dynamicSeen.push(`${typeof key}:${value}:${current === dynamic}`);
  if (key === 'x') dynamic.set(4, 'changed');
});
console.log('dynamic', dynamicSeen.join(','));
new Map<string, number>([['x', 1]]).forEach(function (this: number) { console.log('this', this); }, 5);
let visits = 0;
console.log('return', new Map<string, number>([['x', 1]]).forEach(() => { visits++; }), visits);

const invalid: any = 7;
try { new Map<string, number>().forEach(invalid); } catch (error) { console.log('invalid', error instanceof TypeError); }
try {
  // @ts-expect-error JavaScript permits the call but rejects its missing callback at runtime.
  new Map<string, number>().forEach();
} catch (error) { console.log('missing', error instanceof TypeError); }
let argumentOrder = '';
function extra(): number { argumentOrder += 'extra'; return 0; }
try {
  // @ts-expect-error Extra JavaScript arguments are evaluated before the callback check.
  new Map<string, number>().forEach(invalid, undefined, extra());
} catch (error) { console.log('extra', error instanceof TypeError, argumentOrder); }
function callbackError(value: any): string {
  try { new Map<string, number>().forEach(value); }
  catch (error) { return (error as Error).message; }
  return 'no error';
}
console.log('messages', callbackError(undefined), callbackError(null), callbackError(7), callbackError('abc'), callbackError(true), callbackError(1n), callbackError(Symbol('x')), callbackError({}));
