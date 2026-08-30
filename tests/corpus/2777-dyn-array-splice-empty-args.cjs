'use strict';

const values = JSON.parse('[1,2,3]');
const removed = values.splice();
console.log(JSON.stringify(removed), JSON.stringify(values), removed === values);
