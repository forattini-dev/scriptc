'use strict';

const values = JSON.parse('[10,2,1]');
const sorted = values.toSorted();
console.log(sorted.join(','), values.join(','), sorted === values);
