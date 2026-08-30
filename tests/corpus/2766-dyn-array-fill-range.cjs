'use strict';

const values = JSON.parse('[1,2,3,4]');
const same = values.fill('x', 1, 3);
console.log(values.join(','), same === values);
