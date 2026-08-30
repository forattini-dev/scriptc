'use strict';

const values = JSON.parse('[1,2,3]');
const copied = values.toSpliced();
console.log(JSON.stringify(copied), JSON.stringify(values), copied === values);
