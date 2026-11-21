const numbers = new Map<string, number>([['a', 1], ['b', 2]]);
let sum = 0;
for (const value of numbers.values()) {
  sum += value;
  if (value === 1) numbers.set('c', 3);
}
console.log('sum', sum);
const values = new Map<any, any>();
values.set('x', 'first');
values.set(2, false);
for (const value of values.values()) console.log('mixed', typeof value, JSON.stringify(value));
