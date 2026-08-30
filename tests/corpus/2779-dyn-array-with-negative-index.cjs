'use strict';

const values = JSON.parse('[1,2,3]');
const replaced = values.with(-1, 9);
console.log(JSON.stringify(replaced), JSON.stringify(values), replaced === values);
