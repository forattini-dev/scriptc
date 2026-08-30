'use strict';

const values = JSON.parse('[1,[2,3],4]');
const flattened = values.flat();
console.log(flattened.join(','), values.length, flattened === values);
