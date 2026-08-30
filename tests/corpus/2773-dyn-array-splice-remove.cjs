'use strict';

const values = JSON.parse('[1,2,3,4]');
const removed = values.splice(1, 2);
console.log(JSON.stringify(removed), JSON.stringify(values));
