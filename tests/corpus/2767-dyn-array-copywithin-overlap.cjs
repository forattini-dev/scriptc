'use strict';

const values = JSON.parse('[1,2,3,4,5]');
const same = values.copyWithin(1, 0, 4);
console.log(values.join(','), same === values);
