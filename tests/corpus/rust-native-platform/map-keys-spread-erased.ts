// @rust-only
// @no-engine
const strings = new Map<string, number>([['a', 1], ['b', 2]]);
const erased: any = strings;
console.log('strings', [...erased.keys()].join(','));
const numbers = new Map<number, string>([[2, 'two'], [1, 'one']]);
const numbersErased: any = numbers;
console.log('numbers', [...numbersErased.keys()].join(','));
