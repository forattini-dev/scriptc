const target: { a?: number; b?: number } = {};
const first = { a: 1 };
const second = { b: 2 };
const result = Object.assign(target, first, second);
console.log('values', result === target, target.a, target.b);
