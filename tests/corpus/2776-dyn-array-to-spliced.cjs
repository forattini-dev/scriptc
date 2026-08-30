'use strict';

const values = JSON.parse('[1,2,3,4]');
const replaced = values.toSpliced(1, 2, 'x');
console.log(JSON.stringify(replaced), JSON.stringify(values), replaced === values);
