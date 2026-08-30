'use strict';

const values = JSON.parse('[1,2,3,2]');
const index = values.findLastIndex((value) => value === 2);
console.log(index, values.join(','));
