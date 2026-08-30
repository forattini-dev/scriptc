'use strict';

const values = JSON.parse('[1,2,3]');
console.log(values.reduce((accumulator, value) => accumulator + value, 10));
