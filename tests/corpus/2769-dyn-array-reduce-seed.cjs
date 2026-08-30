'use strict';

const values = JSON.parse('[10,3,2]');
console.log(values.reduce((accumulator, value) => accumulator - value));
