// @no-engine
const numbers: number[] = [];
numbers[2] = 4;
console.log(numbers.indexOf((numbers[0])), numbers.includes((numbers[0])), numbers.lastIndexOf((numbers[0])));
const refs: number[][] = [[1]];
console.log(refs.indexOf(refs[2]), refs.includes(refs[2]), refs.lastIndexOf(refs[2]));
const optional: (number | undefined)[] = [];
optional[2] = undefined;
console.log(optional.indexOf(optional[0]), optional.includes(optional[0]), optional.lastIndexOf(optional[0]));
