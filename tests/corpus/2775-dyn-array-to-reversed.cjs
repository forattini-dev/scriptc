'use strict';

const values = JSON.parse('[1,2,3]');
const reversed = values.toReversed();
console.log(reversed.join(','), values.join(','), reversed === values);
