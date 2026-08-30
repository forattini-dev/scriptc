'use strict';

const values = JSON.parse('[1,2,3,4,5]');
const found = values.findLast((value) => value % 2 === 0);
console.log(found, values.join(','));
