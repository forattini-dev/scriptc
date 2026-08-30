'use strict';

const values = JSON.parse('[1,2,3]');
console.log(values.reduceRight((accumulator, value) => accumulator * 10 + value, 0));
