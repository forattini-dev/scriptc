console.log(NaN, Infinity, -Infinity);
const notANumber = NaN;
console.log(Number.isNaN(NaN), notANumber === notANumber, Infinity > 100, -Infinity < 0);
console.log(NaN + 1, Infinity - Infinity, 1 / Infinity, 1 / -Infinity);
const values = [NaN, Infinity, -Infinity];
for (const value of values) console.log(value);
