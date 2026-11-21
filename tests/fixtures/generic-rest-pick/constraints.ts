function first<T extends { n: number }>(...values: T[]): T { return values[0]; }
const a = { n: 1, label: 'alpha' };
const b = { n: 2, flag: true };
const one = first(a);
const two = first(b);
one.n = 9;
two.flag = false;
console.log('identity', one === a, two === b, a.n, b.flag);
console.log('fields', one.label, two.flag);
