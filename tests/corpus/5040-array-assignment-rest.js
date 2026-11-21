let first;
let rest;
const source = [1, 2, 3];
const result = ([first, ...rest] = source);

console.log(first, rest.join(','), result === source);
