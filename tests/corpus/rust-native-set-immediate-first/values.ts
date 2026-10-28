const numbers = new Set<number>();
console.log('empty', numbers.values().next().value === undefined);
numbers.add(4);
numbers.add(9);
numbers.add(4);
console.log('first', numbers.values().next().value);
numbers.delete(4);
numbers.add(4);
console.log('reinsert', numbers.values().next().value);
numbers.clear();
console.log('cleared', numbers.values().next().value === undefined);
let calls = 0;
function source(): Set<number> { calls++; return numbers; }
numbers.add(7);
console.log('once', source().values().next().value, calls);
const readonly: ReadonlySet<number> = numbers;
console.log('readonly', readonly.values().next().value);
const zeros = new Set<number>([-0, NaN]);
console.log('zero', 1 / zeros.values().next().value! === Infinity);
