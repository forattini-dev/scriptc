const values = JSON.parse('[]') as string[];
const direct = JSON.stringify(values[0]);
const stringify = JSON.stringify;
const alias: string = stringify(values[0]);
let mutable = JSON.stringify(values[0]);
function inspect() { return [typeof direct, typeof alias, typeof mutable].join(','); }
console.log(inspect());
mutable = 'ready';
console.log(inspect());
